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
        executeSafely("replace subscription snapshots") {
            database.runInTransaction {
                dao.clearSubscriptions()
                if (snapshots.isNotEmpty()) dao.insertSubscriptions(snapshots)
            }
            notifyChanged()
            onComplete?.invoke()
        }
    }

    fun insertIncoming(event: IncomingSmsEventEntity, onComplete: (() -> Unit)? = null) {
        executeSafely("persist incoming SMS") {
            dao.insertIncoming(event)
            notifyChanged()
            onComplete?.invoke()
        }
    }

    fun insertIncomingWithOutbox(
        event: IncomingSmsEventEntity,
        idempotencyKey: String,
        scheduleUpload: Boolean = true,
        onComplete: ((inserted: Boolean) -> Unit)? = null,
        onFailure: ((Throwable) -> Unit)? = null
    ) {
        executor.execute {
            runCatching {
                val inserted = insertIncomingWithOutboxNow(event, idempotencyKey)
                if (scheduleUpload) OutboxScheduler.enqueueNow(context)
                if (inserted) notifyChanged()
                inserted
            }.onSuccess { inserted ->
                // Callbacks touch the spool store; a throwing callback must not
                // kill the store executor thread.
                runCatching { onComplete?.invoke(inserted) }
                    .onFailure { error ->
                        Log.e(TAG, "Incoming SMS completion callback failed", error)
                    }
            }.onFailure { error ->
                Log.e(TAG, "Unable to persist incoming SMS and Outbox row", error)
                runCatching { onFailure?.invoke(error) }
                    .onFailure { callbackError ->
                        Log.e(TAG, "Incoming SMS failure callback failed", callbackError)
                    }
            }
        }
    }

    /**
     * Synchronous durability fallback for the broadcast thread when the spool
     * write failed. Runs the same outbox-arbitrated transaction on the calling
     * thread so the SMS is durable before the receiver returns — a later
     * process kill must not be able to lose it.
     *
     * @return true when this call inserted the rows, false when an equal
     *   idempotency key was already durable (another receiver path won the
     *   race — the SMS is safe either way). Throws when nothing durable was
     *   written; the caller must treat that as unprotected loss risk.
     */
    fun persistIncomingWithOutboxBlocking(
        event: IncomingSmsEventEntity,
        idempotencyKey: String
    ): Boolean {
        val inserted = insertIncomingWithOutboxNow(event, idempotencyKey)
        // Schedule the upload with the durable write, not after it: the
        // process may die before the async Phase-2 path ever runs.
        if (inserted) {
            OutboxScheduler.enqueueNow(context)
            notifyChanged()
        }
        return inserted
    }

    /**
     * Degraded-path follow-up. Phase 1 already committed the durable copy
     * while the spool was down; Phase 2 later learns SIM resolution and the
     * provider-write outcome. Fold those into the existing rows instead of
     * inserting again. An outbox row that already left PENDING/RETRY keeps
     * its payload — that snapshot is on (or on its way to) the server.
     */
    fun enrichIncomingAfterDegradedPersist(
        event: IncomingSmsEventEntity,
        idempotencyKey: String,
        onComplete: (() -> Unit)? = null,
        onFailure: ((Throwable) -> Unit)? = null
    ) {
        executor.execute {
            runCatching {
                database.runInTransaction {
                    dao.insertIncoming(event)
                    val outbox = dao.findOutboxByIdempotencyKey(idempotencyKey)
                    val unsent = outbox != null &&
                        (outbox.status == OutboxStatus.PENDING.name ||
                            outbox.status == OutboxStatus.RETRY.name)
                    if (outbox != null && unsent) {
                        OutboxHelper.applyIncomingEnrichment(outbox, event)
                        dao.updateOutbox(outbox)
                    }
                }
                notifyChanged()
            }.onSuccess {
                runCatching { onComplete?.invoke() }
                    .onFailure { error ->
                        Log.e(TAG, "Degraded incoming SMS completion callback failed", error)
                    }
            }.onFailure { error ->
                Log.e(TAG, "Unable to enrich degraded incoming SMS", error)
                runCatching { onFailure?.invoke(error) }
                    .onFailure { callbackError ->
                        Log.e(TAG, "Degraded incoming SMS failure callback failed", callbackError)
                    }
            }
        }
    }

    private fun insertIncomingWithOutboxNow(
        event: IncomingSmsEventEntity,
        idempotencyKey: String
    ): Boolean {
        val outboxEvent = OutboxHelper.createOutboxForIncoming(event, idempotencyKey)
        var inserted = false
        database.runInTransaction {
            // The manifest receiver and the runtime HyperOS fallback can
            // observe the same broadcast. The unique idempotencyKey index
            // is the single cross-process arbiter: only the transaction
            // whose outbox insert actually landed may insert the incoming
            // row. A pre-check alone races between :sms_receiver and main.
            val outboxRowId = dao.insertOutbox(outboxEvent)
            if (outboxRowId != -1L) {
                dao.insertIncoming(event)
                inserted = true
            }
        }
        return inserted
    }

    fun enqueueOutboxSelfTest(onComplete: (() -> Unit)? = null) {
        executeSafely("enqueue Outbox self-test") {
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
        executeSafely("persist notification and Outbox row") {
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
        executeSafely("persist call state and Outbox row") {
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
        executeSafely("persist call identity and Outbox row") {
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
        dispatch: () -> Unit,
        onPersisted: (() -> Unit)? = null,
        onFailure: ((Throwable) -> Unit)? = null
    ) {
        executeSafely(
            operation = "persist outgoing SMS",
            onFailure = onFailure
        ) {
            var inserted = false
            var resumeDispatch = false
            var statusQueued = false
            database.runInTransaction {
                val existing = dao.findOutgoing(event.eventId)
                if (existing == null) {
                    dao.insertOutgoing(event)
                    inserted = true
                    statusQueued = queueOutgoingStatus(event)
                } else if (
                    existing.status == OutgoingStatus.CREATED.name &&
                    existing.partCount == 0
                ) {
                    // Persisted but never dispatched: the process died between
                    // the Room write and the modem dispatch. Re-dispatch — a
                    // row in any later state means sendTextMessage was already
                    // reached and re-sending would duplicate the SMS.
                    resumeDispatch = true
                }
            }
            if (statusQueued) OutboxScheduler.enqueueNow(context)
            notifyChanged()
            if (inserted || resumeDispatch) dispatch()
            onPersisted?.invoke()
        }
    }

    fun insertRemoteCommandFailure(event: OutgoingSmsEventEntity) {
        executeSafely("persist remote command failure") {
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

    fun markDispatching(
        eventId: String,
        partCount: Int,
        onComplete: (() -> Unit)? = null,
        onFailure: ((Throwable) -> Unit)? = null
    ) {
        executeSafely(
            operation = "mark SMS dispatching",
            onFailure = onFailure
        ) action@{
            val event = dao.findOutgoing(eventId) ?: return@action
            event.status = OutgoingStatus.DISPATCHING.name
            event.partCount = partCount
            event.updatedAt = System.currentTimeMillis()
            val statusQueued = database.runInTransaction<Boolean> {
                dao.updateOutgoing(event)
                queueOutgoingStatus(event)
            }
            if (statusQueued) OutboxScheduler.enqueueNow(context)
            notifyChanged()
            onComplete?.invoke()
        }
    }

    fun markDispatchFailure(eventId: String, detail: String) {
        executeSafely("persist SMS dispatch failure") action@{
            val event = dao.findOutgoing(eventId) ?: return@action
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

    fun recordSentCallback(eventId: String, partIndex: Int, resultCode: Int) {
        executor.execute {
            runCatching {
                var changed = false
                var statusQueued = false
                database.runInTransaction {
                    val event = dao.findOutgoing(eventId) ?: return@runInTransaction
                    if (partIndex !in 0 until event.partCount) return@runInTransaction
                    val inserted = dao.insertOutgoingPartResult(
                        OutgoingSmsPartResultEntity(
                            eventId,
                            partIndex,
                            OutgoingPartCallbackType.SENT.name,
                            resultCode,
                            System.currentTimeMillis()
                        )
                    )
                    if (inserted == -1L) return@runInTransaction
                    changed = true
                    event.lastResultCode = resultCode
                    event.updatedAt = System.currentTimeMillis()
                    if (resultCode == Activity.RESULT_OK) {
                        event.sentPartCount += 1
                        if (
                            event.sentPartCount >= event.partCount
                            && event.failedPartCount == 0
                        ) {
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
                    statusQueued = queueOutgoingStatus(event)
                }
                if (statusQueued) OutboxScheduler.enqueueNow(context)
                if (changed) notifyChanged()
            }.onFailure { error ->
                Log.e(TAG, "Unable to persist SMS sent callback", error)
            }
        }
    }

    fun recordDeliveryCallback(eventId: String, partIndex: Int, resultCode: Int) {
        executor.execute {
            runCatching {
                var changed = false
                var statusQueued = false
                database.runInTransaction {
                    val event = dao.findOutgoing(eventId) ?: return@runInTransaction
                    if (partIndex !in 0 until event.partCount) return@runInTransaction
                    val inserted = dao.insertOutgoingPartResult(
                        OutgoingSmsPartResultEntity(
                            eventId,
                            partIndex,
                            OutgoingPartCallbackType.DELIVERED.name,
                            resultCode,
                            System.currentTimeMillis()
                        )
                    )
                    if (inserted == -1L) return@runInTransaction
                    changed = true
                    event.lastResultCode = resultCode
                    event.updatedAt = System.currentTimeMillis()
                    if (resultCode == Activity.RESULT_OK) {
                        event.deliveredPartCount += 1
                        if (
                            event.deliveredPartCount >= event.partCount
                            && event.failedPartCount == 0
                        ) {
                            event.status = OutgoingStatus.DELIVERED.name
                        }
                    } else {
                        // A failed delivery report is a terminal outcome —
                        // without this the row sits in SENT_TO_MODEM forever
                        // when the operator never confirms delivery.
                        event.status = OutgoingStatus.FAILED.name
                        event.errorDetail =
                            "Delivery report result=$resultCode (operator-dependent)"
                    }
                    dao.updateOutgoing(event)
                    statusQueued = queueOutgoingStatus(event)
                }
                if (statusQueued) OutboxScheduler.enqueueNow(context)
                if (changed) notifyChanged()
            }.onFailure { error ->
                Log.e(TAG, "Unable to persist SMS delivery callback", error)
            }
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
        executeSafely("load local event history") {
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
        executeSafely("clear local event history") {
            database.runInTransaction {
                dao.clearIncoming()
                // Remote-command rows and their status uploads are operational
                // state: deleting them strands the server row at CLAIMED and a
                // lease requeue re-sends the SMS to the recipient a second
                // time. Keep them until the command settles server-side.
                dao.clearLocalOutgoing()
                dao.clearNotifications()
                dao.clearCalls()
                dao.clearCallIdentities()
                // Outbox rows contain copies of sender/body data and must
                // follow the same user-visible clear operation.
                dao.clearOutboxKeepingRemoteStatus()
            }
            notifyChanged()
            onComplete?.invoke()
        }
    }

    private fun notifyChanged() {
        PocEventChangeNotifier.notify(context)
    }

    private fun executeSafely(
        operation: String,
        onFailure: ((Throwable) -> Unit)? = null,
        block: () -> Unit
    ) {
        executor.execute {
            runCatching(block).onFailure { error ->
                Log.e(TAG, "Unable to $operation", error)
                onFailure?.invoke(error)
            }
        }
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

enum class OutgoingPartCallbackType {
    SENT,
    DELIVERED
}
