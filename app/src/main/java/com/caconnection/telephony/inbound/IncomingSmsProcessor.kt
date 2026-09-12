package com.caconnection.telephony.inbound

import android.content.Context
import android.content.Intent
import com.caconnection.data.poc.IncomingSmsEventEntity
import com.caconnection.data.poc.PocEventStore
import com.caconnection.notifications.NotificationHelper
import com.caconnection.telephony.subscription.SubscriptionRepository
import java.util.UUID
import java.util.concurrent.Executors

object IncomingSmsProcessor {
    private val executor = Executors.newSingleThreadExecutor()

    fun process(context: Context, intent: Intent, onComplete: () -> Unit) {
        executor.execute {
            runCatching {
                val parsed = SmsParser.parse(intent) ?: return@runCatching null
                val extras = IntentExtrasInspector.asMap(intent)
                val subscriptions = SubscriptionRepository(context).getActiveSubscriptions()
                val resolution = IncomingSimResolver.resolve(intent.action, extras, subscriptions)
                val isDefaultDelivery = intent.action == android.provider.Telephony.Sms.Intents.SMS_DELIVER_ACTION
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
                    val provider = DefaultSmsProviderWriter.saveIncoming(context, event)
                    event.providerWriteStatus = provider.status
                    event.providerUri = provider.uri
                    event.providerWriteError = provider.error
                }
                event to isDefaultDelivery
            }.onSuccess { result ->
                if (result == null) {
                    onComplete()
                } else {
                    val (event, shouldNotify) = result
                    PocEventStore.get(context).insertIncomingWithOutbox(event) {
                        if (shouldNotify) NotificationHelper.notifyIncoming(context, event)
                        onComplete()
                    }
                }
            }.onFailure {
                onComplete()
            }
        }
    }
}
