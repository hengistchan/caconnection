package com.caconnection.telephony.inbound

import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log
import com.caconnection.data.poc.IncomingSmsEventEntity
import com.caconnection.data.poc.OutboxHelper
import com.caconnection.data.poc.PocEventStore
import com.caconnection.notifications.NotificationHelper
import com.caconnection.notifications.GatewayForegroundService
import com.caconnection.telephony.subscription.SubscriptionRepository
import com.caconnection.transport.DeviceStateReporter
import com.caconnection.worker.OutboxScheduler
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

object IncomingSmsProcessor {
    private const val TAG = "IncomingSmsProcessor"
    private val executor = Executors.newSingleThreadExecutor()

    /**
     * Processing is split into two phases so the window in which process death
     * loses the SMS is as small as possible.
     *
     * Phase 1 runs synchronously on the broadcast thread: parse the intent and
     * land a durable copy. The normal durable copy is the spool entry
     * ([SmsSpoolStore.stage]); if that write fails, the degraded path persists
     * Room + outbox synchronously before returning. Android / HyperOS can kill
     * the process at any moment — everything before one of those two writes
     * completes is unrecoverable loss, and nothing after it is.
     *
     * Phase 2 runs on the worker: SIM resolution, provider write, Room/outbox
     * persistence (or enrichment, on the degraded path) and scheduling.
     * Losing it to process death is safe — Phase 1 is the recovery point and
     * [SmsSpoolRecovery] replays a staged entry.
     */
    fun process(context: Context, intent: Intent, onComplete: () -> Unit) {
        val applicationContext = context.applicationContext
        val invokedAt = System.currentTimeMillis()
        val action = when (intent.action) {
            Telephony.Sms.Intents.SMS_RECEIVED_ACTION -> "SMS_RECEIVED"
            Telephony.Sms.Intents.SMS_DELIVER_ACTION -> "SMS_DELIVER"
            else -> {
                onComplete()
                return
            }
        }
        val completion = CompletionGuard(onComplete)

        Log.i(TAG, "SMS receiver invoked action=$action")

        val parsed = try {
            SmsParser.parse(intent)
        } catch (error: RuntimeException) {
            Log.e(TAG, "SMS parser failed action=$action", error)
            reportFailureAsync(
                applicationContext,
                invokedAt,
                action,
                "PARSER_EXCEPTION",
                completion
            )
            return
        }
        if (parsed == null) {
            Log.w(TAG, "SMS parser returned no messages action=$action")
            reportFailureAsync(applicationContext, invokedAt, action, "NO_MESSAGES", completion)
            return
        }

        val isDefaultDelivery =
            intent.action == Telephony.Sms.Intents.SMS_DELIVER_ACTION
        // Immutable broadcast facts only — never live subscription lookups.
        // The key is computed once here and travels with the spool entry;
        // every later path (Phase 2, spool replay) reuses it verbatim.
        val extras = IntentExtrasInspector.asMap(intent)
        val simCandidates = IncomingSimResolver.broadcastCandidates(extras)
        val idempotencyKey = OutboxHelper.incomingIdempotencyKey(
            parsed.originatingAddress,
            parsed.receivedAt,
            parsed.body,
            parsed.partCount,
            simCandidates.subscriptionId,
            simCandidates.slotIndex
        )
        val staged = IncomingSmsEventEntity(
            UUID.randomUUID().toString(),
            intent.action.orEmpty(),
            parsed.originatingAddress,
            parsed.body,
            parsed.receivedAt,
            System.currentTimeMillis(),
            parsed.partCount,
            null,
            null,
            null,
            null,
            null,
            null,
            if (isDefaultDelivery) "PENDING" else "NOT_APPLICABLE",
            null,
            null
        )
        // Durability contract for the broadcast thread — the SMS is protected
        // only after one of these layers has actually landed:
        //
        //  1. Spool: [SmsSpoolStore.stage] returns → the normal path. Phase-2
        //     loss is recoverable; [SmsSpoolRecovery] replays the entry.
        //  2. Room (degraded): stage() threw → persist the incoming + outbox
        //     rows synchronously here, before the receiver returns. Survives
        //     process death even with a broken spool.
        //  3. Neither: the SMS is unprotected. Keep going (Phase 2 may still
        //     land the Room write if the fault was transient) but the critical
        //     log line below is the only trace if it does not.
        var persistedViaRoom = false
        try {
            SmsSpoolStore.stage(applicationContext, staged, idempotencyKey)
        } catch (error: Exception) {
            Log.e(TAG, "Unable to stage SMS spool entry action=$action", error)
            persistedViaRoom = try {
                PocEventStore.get(applicationContext)
                    .persistIncomingWithOutboxBlocking(staged, idempotencyKey)
                Log.w(TAG, "SMS durable via Room fallback only action=$action")
                true
            } catch (roomError: Exception) {
                Log.e(
                    TAG,
                    "CRITICAL: no durable copy of incoming SMS — spool and Room both failed " +
                        "action=$action",
                    roomError
                )
                // Diagnostic only — the real completion is owned by Phase 2
                // (or by the scheduling failure path below).
                try {
                    executor.execute {
                        reportFailure(applicationContext, invokedAt, action, "NO_DURABLE_COPY") {}
                    }
                } catch (diagnosticError: Exception) {
                    Log.e(TAG, "Unable to report missing durable copy", diagnosticError)
                }
                false
            }
        }

        try {
            executor.execute {
                processStaged(
                    applicationContext,
                    intent,
                    extras,
                    invokedAt,
                    action,
                    staged,
                    idempotencyKey,
                    isDefaultDelivery,
                    persistedViaRoom,
                    completion
                )
            }
        } catch (error: Exception) {
            Log.e(TAG, "Unable to schedule SMS processing action=$action", error)
            // Exactly the protection Phase 1 established still holds: a staged
            // spool entry is replayed by SmsSpoolRecovery, a Room-only degraded
            // persist needs no replay. If neither landed, this SMS is lost and
            // the diagnostic above is the only record.
            reportFailureAsync(
                applicationContext,
                invokedAt,
                action,
                "PROCESSING_EXCEPTION",
                completion
            )
        }
    }

    private fun processStaged(
        applicationContext: Context,
        intent: Intent,
        extras: Map<String, Any?>,
        invokedAt: Long,
        action: String,
        event: IncomingSmsEventEntity,
        idempotencyKey: String,
        isDefaultDelivery: Boolean,
        persistedViaRoom: Boolean,
        completion: CompletionGuard
    ) {
        try {
            reportReceiverInvocation(applicationContext, invokedAt, action)

            try {
                val subscriptions = SubscriptionRepository(applicationContext)
                    .getActiveSubscriptions()
                val resolution = IncomingSimResolver.resolve(
                    intent.action,
                    extras,
                    subscriptions
                )
                event.resolvedSubscriptionId = resolution.subscriptionId
                event.resolvedSlotIndex = resolution.slotIndex
                event.resolutionMethod = resolution.method.name
                event.resolutionConfidence = resolution.confidence.name
                event.resolutionNotes = resolution.notes
                event.rawExtras = IntentExtrasInspector.describe(extras)
                updateSpool(applicationContext, event, idempotencyKey)
                if (isDefaultDelivery) {
                    val provider = DefaultSmsProviderWriter.saveIncoming(
                        applicationContext,
                        event
                    )
                    event.providerWriteStatus = provider.status
                    event.providerUri = provider.uri
                    event.providerWriteError = provider.error
                    updateSpool(applicationContext, event, idempotencyKey)
                }
            } catch (error: Exception) {
                Log.e(TAG, "SMS resolution failed action=$action", error)
                reportFailure(
                    applicationContext,
                    invokedAt,
                    action,
                    "PROCESSING_EXCEPTION",
                    completion::finish
                )
                return
            }

            if (persistedViaRoom) {
                // Phase 1 already committed the durable copy on the degraded
                // path. Fold resolution results into those rows — a second
                // insert would be deduped by the idempotency key and silently
                // drop the SIM attribution.
                PocEventStore.get(applicationContext).enrichIncomingAfterDegradedPersist(
                    event,
                    idempotencyKey,
                    onComplete = {
                        afterIncomingPersisted(
                            applicationContext,
                            action,
                            event,
                            isDefaultDelivery,
                            inserted = true,
                            completion
                        )
                    },
                    onFailure = { error ->
                        Log.e(
                            TAG,
                            "Incoming SMS enrichment failed action=$action",
                            error
                        )
                        reportFailure(
                            applicationContext,
                            invokedAt,
                            action,
                            "PROCESSING_EXCEPTION",
                            completion::finish
                        )
                    }
                )
            } else {
                PocEventStore.get(applicationContext).insertIncomingWithOutbox(
                    event,
                    idempotencyKey,
                    scheduleUpload = false,
                    onComplete = { inserted ->
                        afterIncomingPersisted(
                            applicationContext,
                            action,
                            event,
                            isDefaultDelivery,
                            inserted,
                            completion
                        )
                    },
                    onFailure = { error ->
                        Log.e(
                            TAG,
                            "Incoming SMS persistence failed action=$action",
                            error
                        )
                        reportFailure(
                            applicationContext,
                            invokedAt,
                            action,
                            "PROCESSING_EXCEPTION",
                            completion::finish
                        )
                    }
                )
            }
        } catch (error: Exception) {
            Log.e(TAG, "Unexpected SMS processing failure action=$action", error)
            reportFailure(
                applicationContext,
                invokedAt,
                action,
                "PROCESSING_EXCEPTION",
                completion::finish
            )
        }
    }

    private fun afterIncomingPersisted(
        applicationContext: Context,
        action: String,
        event: IncomingSmsEventEntity,
        isDefaultDelivery: Boolean,
        inserted: Boolean,
        completion: CompletionGuard
    ) {
        // The spool entry is recovery state, not the durability gate — a
        // failing cleanup must never abort the completion path (which would
        // strand the receiver's goAsync() result).
        runCatching { SmsSpoolStore.remove(applicationContext, event.eventId) }
            .onFailure { error ->
                Log.e(TAG, "Unable to clear SMS spool entry action=$action", error)
            }
        // WorkManager outbox work is durable: it survives process
        // death and is executed once the system restarts the app.
        OutboxScheduler.enqueueNow(applicationContext)
        GatewayForegroundService.requestRecovery(applicationContext)
        if (inserted) {
            Log.i(
                TAG,
                "Incoming SMS persisted and queued action=$action"
            )
            if (isDefaultDelivery) {
                NotificationHelper.notifyIncoming(
                    applicationContext,
                    event
                )
            }
        } else {
            Log.i(
                TAG,
                "Duplicate incoming SMS ignored action=$action"
            )
        }
        completion.finish()
    }

    /**
     * Spool updates only refresh the crash-recovery state. Once the entry is
     * staged (or the degraded Room persist landed) they are never allowed to
     * abort the pipeline — a broken spool must not also cost the Room write.
     */
    private fun updateSpool(
        context: Context,
        event: IncomingSmsEventEntity,
        idempotencyKey: String
    ) {
        runCatching { SmsSpoolStore.update(context, event, idempotencyKey) }
            .onFailure { error ->
                Log.e(TAG, "Unable to refresh SMS spool entry ${event.eventId}", error)
            }
    }

    private fun reportReceiverInvocation(
        context: Context,
        invokedAt: Long,
        action: String
    ) {
        DeviceStateReporter.enqueue(
            context,
            DeviceStateReporter.ReceiverDiagnostic(
                invokedAt = invokedAt,
                action = action
            )
        )
    }

    /**
     * Failure reporting before the worker takes over. It runs on the worker so
     * the broadcast thread never blocks on diagnostics, but [CompletionGuard]
     * must still complete even if scheduling fails.
     */
    private fun reportFailureAsync(
        context: Context,
        invokedAt: Long,
        action: String,
        reason: String,
        completion: CompletionGuard
    ) {
        try {
            executor.execute {
                reportFailure(context, invokedAt, action, reason, completion::finish)
            }
        } catch (error: Exception) {
            Log.e(TAG, "Unable to schedule failure report action=$action", error)
            completion.finish()
        }
    }

    private fun reportFailure(
        context: Context,
        invokedAt: Long,
        action: String,
        reason: String,
        onComplete: () -> Unit
    ) {
        DeviceStateReporter.enqueue(
            context,
            DeviceStateReporter.ReceiverDiagnostic(
                invokedAt = invokedAt,
                action = action,
                parseFailureAt = System.currentTimeMillis(),
                parseFailureReason = reason
            ),
            onComplete
        )
    }
}

internal class CompletionGuard(private val onComplete: () -> Unit) {
    private val completed = AtomicBoolean(false)

    fun finish() {
        if (completed.compareAndSet(false, true)) {
            onComplete()
        }
    }
}
