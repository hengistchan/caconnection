package com.caconnection.telephony.inbound

import android.content.Context
import android.util.Log
import com.caconnection.data.poc.IncomingSmsEventEntity
import com.caconnection.data.poc.OutboxHelper
import com.google.gson.Gson
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile

/**
 * Small app-private durability layer used before Room and network processing.
 * Each entry is written atomically and can be recovered by the main process.
 *
 * Durability contract: an entry is durable only after [write] returns —
 * write-to-tmp + fsync + rename. A surviving `.tmp` is a write that never
 * completed its rename (process death or OEM rename failure); [loadAll]
 * promotes complete ones so they do not linger unreadable forever.
 */
object SmsSpoolStore {
    private const val TAG = "SmsSpoolStore"
    private const val DIRECTORY = "incoming-sms-spool"
    private const val LOCK_FILE = ".lock"
    private const val JSON_SUFFIX = ".json"
    private const val TMP_FRAGMENT = ".tmp"
    private const val TEMP_SUFFIX = "$JSON_SUFFIX$TMP_FRAGMENT"
    private const val CORRUPT_SUFFIX = ".corrupt"
    private val gson = Gson()

    /**
     * A staged SMS together with the idempotency key computed once at stage
     * time. Replays must reuse the stored key — recomputing it from entity
     * state that changes between staging and resolution would produce a
     * second key for the same SMS and upload it twice.
     */
    data class SpooledSms(
        val event: IncomingSmsEventEntity,
        val idempotencyKey: String?
    )

    fun stage(context: Context, event: IncomingSmsEventEntity, idempotencyKey: String) {
        write(context, SpoolEntry.fromEntity(event, idempotencyKey))
    }

    fun update(context: Context, event: IncomingSmsEventEntity, idempotencyKey: String) {
        write(context, SpoolEntry.fromEntity(event, idempotencyKey))
    }

    fun remove(context: Context, eventId: String) {
        withDirectoryLock(context) { directory ->
            File(directory, "$eventId$JSON_SUFFIX").delete()
            File(directory, "$eventId$TEMP_SUFFIX").delete()
        }
    }

    fun loadAll(context: Context): List<SpooledSms> =
        withDirectoryLock(context) { directory ->
            recoverInterruptedWrites(directory)
            directory.listFiles { file ->
                file.isFile && file.name.endsWith(JSON_SUFFIX)
            }
                .orEmpty()
                .sortedBy(File::lastModified)
                .mapNotNull { file ->
                    runCatching {
                        val entry = gson.fromJson(file.readText(), SpoolEntry::class.java)
                            ?: error("empty spool entry")
                        entry.toSpooled()
                    }.getOrElse { error ->
                        // Never drop an unreadable durability entry silently —
                        // quarantine it so the loss stays visible.
                        Log.e(TAG, "Quarantining unreadable SMS spool entry ${file.name}", error)
                        runCatching {
                            file.renameTo(File(directory, "${file.name}$CORRUPT_SUFFIX"))
                        }
                        null
                    }
                }
        }

    private fun write(context: Context, entry: SpoolEntry) {
        withDirectoryLock(context) { directory ->
            val target = File(directory, "${entry.eventId}$JSON_SUFFIX")
            val temporary = File(directory, "${entry.eventId}$TEMP_SUFFIX")
            FileOutputStream(temporary).use { output ->
                output.write(gson.toJson(entry).toByteArray(Charsets.UTF_8))
                output.fd.sync()
            }
            check(temporary.renameTo(target)) {
                // The fsync'd .tmp is deliberately left in place: the caller
                // takes its degraded path now, and the next loadAll() either
                // promotes this file or quarantines it as visibly corrupt.
                "Unable to atomically persist SMS spool entry ${target.name}"
            }
        }
    }

    /**
     * Crash recovery for writes whose rename never ran: process death (or an
     * OEM/filesystem rename failure) between the fsync and the rename leaves
     * a `.json.tmp` that loadAll() would never read. Promote complete ones
     * back into the spool and quarantine torn ones — a durability entry must
     * never disappear silently, and a finished write must not stay invisible.
     */
    internal fun recoverInterruptedWrites(directory: File) {
        directory.listFiles { file ->
            file.isFile && file.name.endsWith(TEMP_SUFFIX)
        }.orEmpty().forEach { temporary ->
            // Strip only the ".tmp" fragment: "evt.json.tmp" → "evt.json".
            val target = File(directory, temporary.name.removeSuffix(TMP_FRAGMENT))
            if (!isCompleteEntry(temporary)) {
                // Torn write: the closing brace is missing or required fields
                // never landed. Quarantine so the loss stays visible.
                Log.e(TAG, "Quarantining torn SMS spool temporary ${temporary.name}")
                runCatching {
                    temporary.renameTo(File(directory, "${temporary.name}$CORRUPT_SUFFIX"))
                }
                return@forEach
            }
            // Complete .tmp wins in both cases: with no sibling it is the only
            // copy of a staged entry; with a sibling it is the newer state an
            // interrupted update() was replacing it with. renameTo is atomic.
            if (temporary.renameTo(target)) {
                Log.w(TAG, "Recovered SMS spool entry ${target.name} from interrupted write")
            } else {
                Log.e(TAG, "Unable to promote SMS spool temporary ${temporary.name}")
            }
        }
    }

    /**
     * Gson's lenient parser accepts a truncated object and silently drops the
     * missing fields, so parsing alone cannot tell a finished write from a
     * torn one. The serializer writes one complete JSON document in a single
     * write call: a file that ends with `}` finished, one that does not was
     * cut mid-write. Required-field checks back that up.
     */
    internal fun isCompleteEntry(file: File): Boolean {
        val text = runCatching { file.readText() }.getOrNull() ?: return false
        if (!text.trim().endsWith("}")) return false
        // Field access is inside the runCatching: Gson can leave non-null
        // Kotlin fields null, and a missing eventId must read as "torn" —
        // never as a crash that aborts the whole recovery pass.
        return runCatching {
            val entry = gson.fromJson(text, SpoolEntry::class.java)
            entry != null && entry.eventId.isNotBlank() && entry.receivedAt > 0L
        }.getOrDefault(false)
    }

    private fun directory(context: Context): File {
        val protectedContext = context.createDeviceProtectedStorageContext()
        return File(protectedContext.noBackupFilesDir, DIRECTORY).apply { mkdirs() }
    }

    // FileChannel.lock() is JVM-wide: a second overlapping acquisition from
    // another thread of this process throws OverlappingFileLockException
    // instead of blocking. Serialize threads in-process first, then take the
    // file lock for cross-process exclusion (:sms_receiver vs main).
    private val inProcessMutex = Any()

    private fun <T> withDirectoryLock(context: Context, block: (File) -> T): T {
        val directory = directory(context)
        synchronized(inProcessMutex) {
            val lockFile = File(directory, LOCK_FILE)
            RandomAccessFile(lockFile, "rw").channel.use { channel ->
                channel.lock().use {
                    return block(directory)
                }
            }
        }
    }

    private data class SpoolEntry(
        val eventId: String,
        val action: String?,
        val originatingAddress: String?,
        val body: String?,
        val receivedAt: Long,
        val persistedAt: Long,
        val partCount: Int,
        val resolvedSubscriptionId: Int?,
        val resolvedSlotIndex: Int?,
        val resolutionMethod: String?,
        val resolutionConfidence: String?,
        val resolutionNotes: String?,
        val rawExtras: String?,
        val providerWriteStatus: String?,
        val providerUri: String?,
        val providerWriteError: String?,
        val idempotencyKey: String? = null
    ) {
        fun toSpooled() = SpooledSms(toEntity(), idempotencyKey ?: legacyKey())

        /**
         * Entries staged before key persistence existed. Best effort: derive
         * the historical content key so replayed entries still dedup against
         * rows inserted by the old code.
         */
        private fun legacyKey() = OutboxHelper.generateIdempotencyKey(toEntity())

        fun toEntity() = IncomingSmsEventEntity(
            eventId,
            action,
            originatingAddress,
            body,
            receivedAt,
            persistedAt,
            partCount,
            resolvedSubscriptionId,
            resolvedSlotIndex,
            resolutionMethod,
            resolutionConfidence,
            resolutionNotes,
            rawExtras,
            providerWriteStatus,
            providerUri,
            providerWriteError
        )

        companion object {
            fun fromEntity(event: IncomingSmsEventEntity, idempotencyKey: String) = SpoolEntry(
                event.eventId,
                event.action,
                event.originatingAddress,
                event.body,
                event.receivedAt,
                event.persistedAt,
                event.partCount,
                event.resolvedSubscriptionId,
                event.resolvedSlotIndex,
                event.resolutionMethod,
                event.resolutionConfidence,
                event.resolutionNotes,
                event.rawExtras,
                event.providerWriteStatus,
                event.providerUri,
                event.providerWriteError,
                idempotencyKey
            )
        }
    }
}
