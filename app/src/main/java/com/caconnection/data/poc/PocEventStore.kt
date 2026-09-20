package com.caconnection.data.poc

import android.app.Activity
import android.annotation.SuppressLint
import android.content.Context
import android.telephony.SmsManager
import android.util.Log
import com.caconnection.telephony.inbound.DefaultSmsProviderWriter
import com.caconnection.worker.OutboxScheduler
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

    fun insertIncomingWithOutbox(
        event: IncomingSmsEventEntity,
        onComplete: ((inserted: Boolean) -> Unit)? = null,
        onFailure: ((Throwable) -> Unit)? = null
    ) {
        executor.execute {
            runCatching {
                val outboxEvent = OutboxHelper.createOutboxForIncoming(event)
                var inserted = false
                database.runInTransaction {
                    // The manifest receiver and the runtime HyperOS fallback can
                    // observe the same broadcast. The stable SMS idempotency key
                    // prevents duplicate local rows and duplicate uploads.
                    if (dao.findOutboxByIdempotencyKey(
                            outboxEvent.idempotencyKey
                        ) == null
                    ) {
                        dao.insertIncoming(event)
                        dao.insertOutbox(outboxEvent)
                        inserted = true
                    }
                }
                OutboxScheduler.enqueueNow(context)
                if (inserted) notifyChanged()
                inserted
            }.onSuccess { inserted ->
                onComplete?.invoke(inserted)
            }.onFailure { error ->
                Log.e(TAG, "Unable to persist incoming SMS and Outbox row", error)
                onFailure?.invoke(error)
            }
        }
    }

    fun enqueueOutboxSelfTest(onComplete: (() -> Unit)? = null) {
        executor.execute {
            dao.insertOutbox(OutboxHelper.createLocalSelfTest())
            OutboxScheduler.enqueueNow(context)
            notifyChanged()
            onComplete?.invoke()
        }
    }

    fun enqueueDeviceState(
        payload: OutboxHelper.DeviceStatePayload,
        onComplete: (() -> Unit)? = null,
        onFailure: ((Throwable) -> Unit)? = null
    ) {
        executor.execute {
            runCatching {
                dao.insertOutbox(OutboxHelper.createDeviceState(payload))
                OutboxScheduler.enqueueNow(context)
                notifyChanged()
            }.onSuccess {
                onComplete?.invoke()
            }.onFailure { error ->
                Log.e(TAG, "Unable to persist device-state Outbox row", error)
                onFailure?.invoke(error)
            }
        }
    }

    fun insertNotificationWithOutbox(
        event: NotificationEventEntity,
        onComplete: (() -> Unit)? = null
    ) {
        executor.execute {
            database.runInTransaction {
                dao.insertNotification(event)
                dao.insertOutbox(OutboxHelper.createOutboxForNotification(event))
            }
            OutboxScheduler.enqueueNow(context)
            notifyChanged()
            onComplete?.invoke()
        }
    }

    fun insertCallWithOutbox(
        event: CallEventEntity,
        onComplete: (() -> Unit)? = null
    ) {
        executor.execute {
            database.runInTransaction {
                dao.insertCall(event)
                dao.insertOutbox(OutboxHelper.createOutboxForCall(event))
            }
            OutboxScheduler.enqueueNow(context)
            notifyChanged()
            onComplete?.invoke()
        }
    }

    fun insertCallIdentityWithOutbox(
        event: CallIdentityEventEntity,
        onComplete: (() -> Unit)? = null
    ) {
        executor.execute {
            database.runInTransaction {
                dao.insertCallIdentity(event)
                dao.insertOutbox(OutboxHelper.createOutboxForCallIdentity(event))
            }
            OutboxScheduler.enqueueNow(context)
            notifyChanged()
            onComplete?.invoke()
        }
    }

    fun insertOutgoingAndDispatch(
        event: OutgoingSmsEventEntity,
        dispatch: () -> Unit
    ) {
        executor.execute {
            var inserted = false
            var statusQueued = false
            database.runInTransaction {
                if (dao.findOutgoing(event.eventId) == null) {
                    dao.insertOutgoing(event)
                    inserted = true
                    statusQueued = queueOutgoingStatus(event)
                }
            }
            if (statusQueued) OutboxScheduler.enqueueNow(context)
            notifyChanged()
            if (inserted) dispatch()
        }
    }

    fun insertRemoteCommandFailure(event: OutgoingSmsEventEntity) {
        executor.execute {
            var statusQueued = false
            database.runInTransaction {
                if (dao.findOutgoing(event.eventId) == null) {
                    dao.insertOutgoing(event)
                    statusQueued = queueOutgoingStatus(event)
                }
            }
            if (statusQueued) OutboxScheduler.enqueueNow(context)
            notifyChanged()
        }
    }

    fun markDispatching(eventId: String, partCount: Int) {
        executor.execute {
            val event = dao.findOutgoing(eventId) ?: return@execute
            event.status = OutgoingStatus.DISPATCHING.name
            event.partCount = partCount
            event.updatedAt = System.currentTimeMillis()
            val statusQueued = database.runInTransaction<Boolean> {
                dao.updateOutgoing(event)
                queueOutgoingStatus(event)
            }
            if (statusQueued) OutboxScheduler.enqueueNow(context)
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
            val statusQueued = database.runInTransaction<Boolean> {
                dao.updateOutgoing(event)
                queueOutgoingStatus(event)
            }
            if (statusQueued) OutboxScheduler.enqueueNow(context)
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
            val statusQueued = database.runInTransaction<Boolean> {
                dao.updateOutgoing(event)
                queueOutgoingStatus(event)
            }
            if (statusQueued) OutboxScheduler.enqueueNow(context)
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
            val statusQueued = database.runInTransaction<Boolean> {
                dao.updateOutgoing(event)
                queueOutgoingStatus(event)
            }
            if (statusQueued) OutboxScheduler.enqueueNow(context)
            notifyChanged()
        }
    }

    fun loadLatest(
        incomingLimit: Int = 50,
        outgoingLimit: Int = 50,
        notificationLimit: Int = 50,
        callLimit: Int = 50,
        callIdentityLimit: Int = 50,
        outboxLimit: Int = 50,
        callback: (
            List<SubscriptionSnapshotEntity>,
            List<IncomingSmsEventEntity>,
            List<OutgoingSmsEventEntity>,
            List<NotificationEventEntity>,
            List<CallEventEntity>,
            List<CallIdentityEventEntity>,
            List<OutboxEventEntity>
        ) -> Unit
    ) {
        executor.execute {
            callback(
                dao.getSubscriptions(),
                dao.getLatestIncoming(incomingLimit),
                dao.getLatestOutgoing(outgoingLimit),
                dao.getLatestNotifications(notificationLimit),
                dao.getLatestCalls(callLimit),
                dao.getLatestCallIdentities(callIdentityLimit),
                dao.getLatestOutboxEvents(outboxLimit)
            )
        }
    }

    fun clearEvents(onComplete: (() -> Unit)? = null) {
        executor.execute {
            database.runInTransaction {
                dao.clearIncoming()
                dao.clearOutgoing()
                dao.clearNotifications()
                dao.clearCalls()
                dao.clearCallIdentities()
                // Outbox rows contain copies of sender/body data and must
                // follow the same user-visible clear operation.
                dao.clearOutbox()
            }
            notifyChanged()
            onComplete?.invoke()
        }
    }

    private fun notifyChanged() {
        PocEventChangeNotifier.notify(context)
    }

    private fun queueOutgoingStatus(event: OutgoingSmsEventEntity): Boolean {
        val outbox = OutboxHelper.createOutboxForOutgoingStatus(event)
            ?: return false
        dao.insertOutbox(outbox)
        return true
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
        private const val TAG = "PocEventStore"
        const val ACTION_DATA_CHANGED = PocEventChangeNotifier.ACTION_DATA_CHANGED

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
