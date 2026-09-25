package com.caconnection.telephony.inbound

import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log
import com.caconnection.data.poc.IncomingSmsEventEntity
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
        reportReceiverInvocation(applicationContext, invokedAt, action)

        runCatching {
            executor.execute {
                processOnWorker(
                    applicationContext,
                    intent,
                    invokedAt,
                    action,
                    completion
                )
            }
        }.onFailure { error ->
            Log.e(TAG, "Unable to schedule SMS processing action=$action", error)
            reportFailure(
                applicationContext,
                invokedAt,
                action,
                "PROCESSING_EXCEPTION",
                completion::finish
            )
        }
    }

    private fun processOnWorker(
        applicationContext: Context,
        intent: Intent,
        invokedAt: Long,
        action: String,
        completion: CompletionGuard
    ) {
        try {
            val parsed = try {
                SmsParser.parse(intent)
            } catch (error: RuntimeException) {
                Log.e(TAG, "SMS parser failed action=$action", error)
                reportFailure(
                    applicationContext,
                    invokedAt,
                    action,
                    "PARSER_EXCEPTION",
                    completion::finish
                )
                return
            }
            if (parsed == null) {
                Log.w(TAG, "SMS parser returned no messages action=$action")
                reportFailure(
                    applicationContext,
                    invokedAt,
                    action,
                    "NO_MESSAGES",
                    completion::finish
                )
                return
            }

            runCatching {
                val extras = IntentExtrasInspector.asMap(intent)
                val subscriptions = SubscriptionRepository(applicationContext)
                    .getActiveSubscriptions()
                val resolution = IncomingSimResolver.resolve(
                    intent.action,
                    extras,
                    subscriptions
                )
                val isDefaultDelivery =
                    intent.action == Telephony.Sms.Intents.SMS_DELIVER_ACTION
                val event = IncomingSmsEventEntity(
                    UUID.randomUUID().toString(),
                    intent.action.orEmpty(),
                    parsed.originatingAddress,
                    parsed.body,
                    parsed.receivedAt,
                    System.currentTimeMillis(),
                    parsed.partCount,
                    resolution.subscriptionId,
                    resolution.slotIndex,
                    resolution.method.name,
                    resolution.confidence.name,
                    resolution.notes,
                    IntentExtrasInspector.describe(extras),
                    if (isDefaultDelivery) "PENDING" else "NOT_APPLICABLE",
                    null,
                    null
                )
                SmsSpoolStore.stage(applicationContext, event)
                if (isDefaultDelivery) {
                    val provider = DefaultSmsProviderWriter.saveIncoming(
                        applicationContext,
                        event
                    )
                    event.providerWriteStatus = provider.status
                    event.providerUri = provider.uri
                    event.providerWriteError = provider.error
                    SmsSpoolStore.update(applicationContext, event)
                }
                event to isDefaultDelivery
            }.onSuccess { result ->
                val (event, shouldNotify) = result
                PocEventStore.get(applicationContext).insertIncomingWithOutbox(
                    event,
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
                            if (shouldNotify) {
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
            }.onFailure { error ->
                Log.e(TAG, "Incoming SMS processing failed action=$action", error)
                reportFailure(
                    applicationContext,
                    invokedAt,
                    action,
                    "PROCESSING_EXCEPTION",
                    completion::finish
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
