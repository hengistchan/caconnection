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
 */
object SmsSpoolStore {
    private const val TAG = "SmsSpoolStore"
    private const val DIRECTORY = "incoming-sms-spool"
    private const val LOCK_FILE = ".lock"
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
            File(directory, "$eventId.json").delete()
            File(directory, "$eventId.json.tmp").delete()
        }
    }

    fun loadAll(context: Context): List<SpooledSms> =
        withDirectoryLock(context) { directory ->
            directory.listFiles { file ->
                file.isFile && file.name.endsWith(".json")
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
            val target = File(directory, "${entry.eventId}.json")
            val temporary = File(directory, "${entry.eventId}.json.tmp")
            FileOutputStream(temporary).use { output ->
                output.write(gson.toJson(entry).toByteArray(Charsets.UTF_8))
                output.fd.sync()
            }
            check(temporary.renameTo(target)) {
                "Unable to atomically persist SMS spool entry"
            }
        }
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
