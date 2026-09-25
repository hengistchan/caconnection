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
     * write the durable spool entry. Android / HyperOS can kill the process at
     * any moment; everything before [SmsSpoolStore.stage] is unrecoverable loss.
     *
     * Phase 2 runs on the worker: SIM resolution, provider write, Room/outbox
     * persistence and scheduling. Losing it to process death is safe — the
     * spool entry is the recovery point and [SmsSpoolRecovery] replays it.
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
        try {
            SmsSpoolStore.stage(applicationContext, staged, idempotencyKey)
        } catch (error: Exception) {
            // The spool write failed; dropping the SMS here would lose it.
            // Keep processing — Room persistence may still succeed, and the
            // Phase-2 update() retries the spool write.
            Log.e(TAG, "Unable to stage SMS spool entry action=$action", error)
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
                    completion
                )
            }
        } catch (error: Exception) {
            Log.e(TAG, "Unable to schedule SMS processing action=$action", error)
            // The spool entry is already durable; SmsSpoolRecovery replays it.
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
                SmsSpoolStore.update(applicationContext, event, idempotencyKey)
                if (isDefaultDelivery) {
                    val provider = DefaultSmsProviderWriter.saveIncoming(
                        applicationContext,
                        event
                    )
                    event.providerWriteStatus = provider.status
                    event.providerUri = provider.uri
                    event.providerWriteError = provider.error
                    SmsSpoolStore.update(applicationContext, event, idempotencyKey)
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

            PocEventStore.get(applicationContext).insertIncomingWithOutbox(
                event,
                idempotencyKey,
                scheduleUpload = false,
                onComplete = { inserted ->
                    SmsSpoolStore.remove(applicationContext, event.eventId)
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
