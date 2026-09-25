package com.caconnection.telephony.inbound

import android.content.Context
import android.util.Log
import com.caconnection.ProcessIdentity
import com.caconnection.data.poc.OutboxHelper
import com.caconnection.data.poc.PocEventStore
import com.caconnection.notifications.GatewayForegroundService
import com.caconnection.telephony.smsrole.SmsRoleController
import java.util.concurrent.Executors

object SmsSpoolRecovery {
    private const val TAG = "SmsSpoolRecovery"
    private val executor = Executors.newSingleThreadExecutor()

    fun recover(context: Context) {
        val applicationContext = context.applicationContext
        if (!ProcessIdentity.isMainProcess(applicationContext)) return
        executor.execute {
            val entries = runCatching {
                SmsSpoolStore.loadAll(applicationContext)
            }.getOrElse { error ->
                Log.e(TAG, "Unable to load SMS spool", error)
                return@execute
            }
            if (entries.isEmpty()) return@execute

            val holdsSmsRole = SmsRoleController(applicationContext).isRoleHeld()
            entries.forEach { spooled ->
                val event = spooled.event
                // Replays must reuse the key stored at stage time. Deriving it
                // again here would produce a second key whenever resolution
                // state changed since staging → duplicate upload.
                val idempotencyKey = spooled.idempotencyKey
                    ?: OutboxHelper.generateIdempotencyKey(event)
                if (holdsSmsRole && event.providerWriteStatus != "SAVED") {
                    // Recovery may re-run after a crash between the provider
                    // write and the spool update — matchExisting protects
                    // against writing the inbox twice for one message.
                    val provider = DefaultSmsProviderWriter.saveIncoming(
                        applicationContext,
                        event,
                        matchExisting = true
                    )
                    event.providerWriteStatus = provider.status
                    event.providerUri = provider.uri
                    event.providerWriteError = provider.error
                    runCatching {
                        SmsSpoolStore.update(applicationContext, event, idempotencyKey)
                    }
                }
                PocEventStore.get(applicationContext).insertIncomingWithOutbox(
                    event = event,
                    idempotencyKey = idempotencyKey,
                    scheduleUpload = true,
                    onComplete = { inserted ->
                        if (!inserted) {
                            // The durable copy already exists — typically the
                            // degraded synchronous persist from the broadcast
                            // thread, which ran before resolution. Fold this
                            // replay's resolution results into those rows.
                            PocEventStore.get(applicationContext)
                                .enrichIncomingAfterDegradedPersist(event, idempotencyKey)
                        }
                        // Cleanup failure must not swallow the refresh below —
                        // a leftover entry is re-recovered and deduped later.
                        runCatching {
                            SmsSpoolStore.remove(applicationContext, event.eventId)
                        }.onFailure { error ->
                            Log.e(TAG, "Unable to clear recovered spool entry", error)
                        }
                        GatewayForegroundService.refresh(applicationContext)
                    },
                    onFailure = { error ->
                        Log.e(TAG, "Unable to recover SMS spool entry", error)
                    }
                )
            }
        }
    }
}
