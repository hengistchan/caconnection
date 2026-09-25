package com.caconnection.telephony.inbound

import android.content.Context
import com.caconnection.data.poc.IncomingSmsEventEntity
import com.google.gson.Gson
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile

/**
 * Small app-private durability layer used before Room and network processing.
 * Each entry is written atomically and can be recovered by the main process.
 */
object SmsSpoolStore {
    private const val DIRECTORY = "incoming-sms-spool"
    private const val LOCK_FILE = ".lock"
    private val gson = Gson()

    fun stage(context: Context, event: IncomingSmsEventEntity) {
        write(context, SpoolEntry.fromEntity(event))
    }

    fun update(context: Context, event: IncomingSmsEventEntity) {
        write(context, SpoolEntry.fromEntity(event))
    }

    fun remove(context: Context, eventId: String) {
        withDirectoryLock(context) { directory ->
            File(directory, "$eventId.json").delete()
            File(directory, "$eventId.json.tmp").delete()
        }
    }

    fun loadAll(context: Context): List<IncomingSmsEventEntity> =
        withDirectoryLock(context) { directory ->
            directory.listFiles { file ->
                file.isFile && file.name.endsWith(".json")
            }
                .orEmpty()
                .sortedBy(File::lastModified)
                .mapNotNull { file ->
                    runCatching {
                        gson.fromJson(file.readText(), SpoolEntry::class.java).toEntity()
                    }.getOrNull()
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

    private fun <T> withDirectoryLock(context: Context, block: (File) -> T): T {
        val directory = directory(context)
        val lockFile = File(directory, LOCK_FILE)
        RandomAccessFile(lockFile, "rw").channel.use { channel ->
            channel.lock().use {
                return block(directory)
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
        val providerWriteError: String?
    ) {
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
            fun fromEntity(event: IncomingSmsEventEntity) = SpoolEntry(
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
                event.providerWriteError
            )
        }
    }
}
