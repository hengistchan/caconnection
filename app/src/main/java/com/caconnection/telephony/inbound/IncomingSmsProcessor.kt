package com.caconnection.telephony.inbound

import android.content.Context
import android.content.Intent
import com.caconnection.data.poc.IncomingSmsEventEntity
import com.caconnection.data.poc.PocEventStore
import com.caconnection.notifications.NotificationHelper
import com.caconnection.telephony.subscription.SubscriptionRepository
import com.caconnection.transport.DeviceStateReporter
import java.util.UUID
import java.util.concurrent.Executors

object IncomingSmsProcessor {
    private val executor = Executors.newSingleThreadExecutor()

    fun process(context: Context, intent: Intent, onComplete: () -> Unit) {
        executor.execute {
            val applicationContext = context.applicationContext
            val invokedAt = System.currentTimeMillis()
            val action = when (intent.action) {
                android.provider.Telephony.Sms.Intents.SMS_RECEIVED_ACTION ->
                    "SMS_RECEIVED"
                android.provider.Telephony.Sms.Intents.SMS_DELIVER_ACTION ->
                    "SMS_DELIVER"
                else -> "UNKNOWN"
            }
            val parsed = try {
                SmsParser.parse(intent)
            } catch (_: RuntimeException) {
                reportParseFailure(
                    applicationContext,
                    invokedAt,
                    action,
                    "PARSER_EXCEPTION",
                    onComplete
                )
                return@execute
            }
            if (parsed == null) {
                reportParseFailure(
                    applicationContext,
                    invokedAt,
                    action,
                    "NO_MESSAGES",
                    onComplete
                )
                return@execute
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
                val isDefaultDelivery = intent.action ==
                    android.provider.Telephony.Sms.Intents.SMS_DELIVER_ACTION
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
                if (isDefaultDelivery) {
                    val provider = DefaultSmsProviderWriter.saveIncoming(
                        applicationContext,
                        event
                    )
                    event.providerWriteStatus = provider.status
                    event.providerUri = provider.uri
                    event.providerWriteError = provider.error
                }
                event to isDefaultDelivery
            }.onSuccess { result ->
                val (event, shouldNotify) = result
                PocEventStore.get(applicationContext).insertIncomingWithOutbox(event) {
                    if (shouldNotify) {
                        NotificationHelper.notifyIncoming(applicationContext, event)
                    }
                    onComplete()
                }
            }.onFailure {
                reportParseFailure(
                    applicationContext,
                    invokedAt,
                    action,
                    "PROCESSING_EXCEPTION",
                    onComplete
                )
            }
        }
    }

    private fun reportParseFailure(
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
