package com.caconnection.telephony.inbound

import android.content.Context
import android.util.Log
import com.caconnection.ProcessIdentity
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
            entries.forEach { event ->
                if (holdsSmsRole && event.providerWriteStatus != "SAVED") {
                    val provider = DefaultSmsProviderWriter.saveIncoming(
                        applicationContext,
                        event
                    )
                    event.providerWriteStatus = provider.status
                    event.providerUri = provider.uri
                    event.providerWriteError = provider.error
                    runCatching { SmsSpoolStore.update(applicationContext, event) }
                }
                PocEventStore.get(applicationContext).insertIncomingWithOutbox(
                    event = event,
                    scheduleUpload = true,
                    onComplete = {
                        SmsSpoolStore.remove(applicationContext, event.eventId)
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
