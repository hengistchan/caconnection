package com.caconnection.data.poc

import android.app.Activity
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.telephony.SmsManager
import com.caconnection.telephony.inbound.DefaultSmsProviderWriter
import java.util.concurrent.Executors

class PocEventStore private constructor(private val context: Context) {
    private val database = PocDatabase.get(context)
    private val dao = database.pocDao()
    private val executor = Executors.newSingleThreadExecutor()

    fun replaceSubscriptions(snapshots: List<SubscriptionSnapshotEntity>, onComplete: (() -> Unit)? = null) {
        executor.execute {
            database.runInTransaction {
                dao.clearSubscriptions()
                if (snapshots.isNotEmpty()) dao.insertSubscriptions(snapshots)
            }
            notifyChanged()
            onComplete?.invoke()
        }
    }

    fun insertIncoming(event: IncomingSmsEventEntity, onComplete: (() -> Unit)? = null) {
        executor.execute {
            dao.insertIncoming(event)
            notifyChanged()
            onComplete?.invoke()
        }
    }
    
    fun insertIncomingWithOutbox(event: IncomingSmsEventEntity, onComplete: (() -> Unit)? = null) {
        executor.execute {
            database.runInTransaction {
                // Insert the incoming event
                dao.insertIncoming(event)
                
                // Create and insert the outbox event in the same transaction
                val outboxEvent = OutboxHelper.createOutboxForIncoming(event)
                dao.insertOutbox(outboxEvent)
            }
            notifyChanged()
            onComplete?.invoke()
        }
    }

    fun insertOutgoingAndDispatch(event: OutgoingSmsEventEntity, dispatch: () -> Unit) {
        executor.execute {
            dao.insertOutgoing(event)
            notifyChanged()
            dispatch()
        }
    }

    fun markDispatching(eventId: String, partCount: Int) {
        executor.execute {
            val event = dao.findOutgoing(eventId) ?: return@execute
            event.status = OutgoingStatus.DISPATCHING.name
            event.partCount = partCount
            event.updatedAt = System.currentTimeMillis()
            dao.updateOutgoing(event)
            notifyChanged()
        }
    }

    fun markDispatchFailure(eventId: String, detail: String) {
        executor.execute {
            val event = dao.findOutgoing(eventId) ?: return@execute
            event.status = OutgoingStatus.FAILED.name
            event.failedPartCount = maxOf(1, event.failedPartCount)
            event.errorDetail = detail
            event.updatedAt = System.currentTimeMillis()
            dao.updateOutgoing(event)
            notifyChanged()
        }
    }

    fun recordSentCallback(eventId: String, resultCode: Int) {
        executor.execute {
            val event = dao.findOutgoing(eventId) ?: return@execute
            event.lastResultCode = resultCode
            event.updatedAt = System.currentTimeMillis()
            if (resultCode == Activity.RESULT_OK) {
                event.sentPartCount += 1
                if (event.sentPartCount >= event.partCount && event.failedPartCount == 0) {
                    event.status = OutgoingStatus.SENT_TO_MODEM.name
                    if (event.providerWriteStatus == "PENDING") {
                        val provider = DefaultSmsProviderWriter.saveOutgoing(context, event)
                        event.providerWriteStatus = provider.status
                        event.providerUri = provider.uri
                        event.providerWriteError = provider.error
                    }
                }
            } else {
                event.failedPartCount += 1
                event.status = OutgoingStatus.FAILED.name
                event.errorDetail = smsResultDescription(resultCode)
            }
            dao.updateOutgoing(event)
            notifyChanged()
        }
    }

    fun recordDeliveryCallback(eventId: String, resultCode: Int) {
        executor.execute {
            val event = dao.findOutgoing(eventId) ?: return@execute
            event.lastResultCode = resultCode
            event.updatedAt = System.currentTimeMillis()
            if (resultCode == Activity.RESULT_OK) {
                event.deliveredPartCount += 1
                if (event.deliveredPartCount >= event.partCount && event.failedPartCount == 0) {
                    event.status = OutgoingStatus.DELIVERED.name
                }
            } else {
                event.errorDetail = "Delivery report result=$resultCode (operator-dependent)"
            }
            dao.updateOutgoing(event)
            notifyChanged()
        }
    }

    fun loadLatest(
        incomingLimit: Int = 50,
        outgoingLimit: Int = 50,
        callback: (List<SubscriptionSnapshotEntity>, List<IncomingSmsEventEntity>, List<OutgoingSmsEventEntity>) -> Unit
    ) {
        executor.execute {
            callback(
                dao.getSubscriptions(),
                dao.getLatestIncoming(incomingLimit),
                dao.getLatestOutgoing(outgoingLimit)
            )
        }
    }

    fun clearEvents(onComplete: (() -> Unit)? = null) {
        executor.execute {
            database.runInTransaction {
                dao.clearIncoming()
                dao.clearOutgoing()
            }
            notifyChanged()
            onComplete?.invoke()
        }
    }

    private fun notifyChanged() {
        context.sendBroadcast(
            Intent(ACTION_DATA_CHANGED)
                .setPackage(context.packageName)
        )
    }

    private fun smsResultDescription(resultCode: Int): String = when (resultCode) {
        SmsManager.RESULT_ERROR_GENERIC_FAILURE -> "Generic modem failure"
        SmsManager.RESULT_ERROR_RADIO_OFF -> "Radio is off"
        SmsManager.RESULT_ERROR_NULL_PDU -> "Null PDU"
        SmsManager.RESULT_ERROR_NO_SERVICE -> "No cellular service"
        SmsManager.RESULT_ERROR_LIMIT_EXCEEDED -> "Sending limit exceeded"
        SmsManager.RESULT_ERROR_FDN_CHECK_FAILURE -> "Fixed Dialing Number check failed"
        SmsManager.RESULT_ERROR_SHORT_CODE_NEVER_ALLOWED -> "Short code is not allowed"
        SmsManager.RESULT_ERROR_SHORT_CODE_NOT_ALLOWED -> "Short code permission denied"
        else -> "SMS send failed with result=$resultCode"
    }

    companion object {
        const val ACTION_DATA_CHANGED = "com.caconnection.action.POC_DATA_CHANGED"

        @SuppressLint("StaticFieldLeak")
        @Volatile
        private var instance: PocEventStore? = null

        fun get(context: Context): PocEventStore =
            instance ?: synchronized(this) {
                instance ?: PocEventStore(context.applicationContext).also { instance = it }
            }
    }
}

enum class OutgoingStatus {
    CREATED,
    DISPATCHING,
    SENT_TO_MODEM,
    DELIVERED,
    FAILED
}
