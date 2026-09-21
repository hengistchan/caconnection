package com.caconnection.telephony.outbound

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.telephony.SmsManager
import androidx.core.content.ContextCompat
import com.caconnection.data.poc.OutgoingSmsEventEntity
import com.caconnection.data.poc.OutgoingStatus
import com.caconnection.data.poc.PocEventStore
import com.caconnection.telephony.smsrole.SmsRoleController
import com.caconnection.telephony.subscription.SubscriptionSnapshot
import java.util.UUID

class SmsGatewaySender(private val context: Context) {
    fun send(
        recipient: String,
        body: String,
        subscription: SubscriptionSnapshot,
        onAccepted: (String) -> Unit,
        onRejected: (String) -> Unit
    ) = sendInternal(
        eventId = UUID.randomUUID().toString(),
        remoteCommandId = null,
        recipient = recipient,
        body = body,
        subscription = subscription,
        onAccepted = onAccepted,
        onRejected = onRejected
    )

    fun sendRemote(
        commandId: String,
        recipient: String,
        body: String,
        subscription: SubscriptionSnapshot,
        onAccepted: (String) -> Unit = {},
        onRejected: (String) -> Unit = {}
    ) = sendInternal(
        eventId = commandId,
        remoteCommandId = commandId,
        recipient = recipient,
        body = body,
        subscription = subscription,
        onAccepted = onAccepted,
        onRejected = onRejected
    )

    private fun sendInternal(
        eventId: String,
        remoteCommandId: String?,
        recipient: String,
        body: String,
        subscription: SubscriptionSnapshot,
        onAccepted: (String) -> Unit,
        onRejected: (String) -> Unit
    ) {
        val validation = validate(recipient, body)
        if (validation != null) {
            onRejected(validation)
            return
        }
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.SEND_SMS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            onRejected("SEND_SMS permission is not granted")
            return
        }

        val now = System.currentTimeMillis()
        val event = OutgoingSmsEventEntity(
            eventId,
            recipient.trim(),
            body,
            now,
            now,
            subscription.subscriptionId,
            subscription.slotIndex,
            subscription.carrierName,
            remoteCommandId,
            OutgoingStatus.CREATED.name,
            0,
            0,
            0,
            0,
            null,
            null,
            if (SmsRoleController(context).isRoleHeld()) "PENDING" else "SYSTEM_MANAGED_NON_DEFAULT",
            null,
            null
        )

        PocEventStore.get(context).insertOutgoingAndDispatch(
            event = event,
            dispatch = { dispatch(event) },
            onPersisted = { onAccepted(eventId) },
            onFailure = {
                onRejected("Unable to persist outgoing SMS")
            }
        )
    }

    private fun dispatch(event: OutgoingSmsEventEntity) {
        try {
            val baseManager = context.getSystemService(SmsManager::class.java)
            val manager = baseManager.createForSubscriptionId(event.requestedSubscriptionId)
            val parts = manager.divideMessage(event.body).takeIf { it.isNotEmpty() }
                ?: arrayListOf(event.body)

            PocEventStore.get(context).markDispatching(
                eventId = event.eventId,
                partCount = parts.size,
                onComplete = {
                    sendPrepared(event, manager, parts)
                },
                onFailure = {
                    PocEventStore.get(context).markDispatchFailure(
                        event.eventId,
                        "Unable to persist dispatch state"
                    )
                }
            )
        } catch (error: Throwable) {
            PocEventStore.get(context).markDispatchFailure(
                event.eventId,
                "${error.javaClass.simpleName}: SMS dispatch preparation failed"
            )
        }
    }

    private fun sendPrepared(
        event: OutgoingSmsEventEntity,
        manager: SmsManager,
        parts: ArrayList<String>
    ) {
        try {
            val sentIntents = ArrayList<PendingIntent>(parts.size)
            val deliveryIntents = ArrayList<PendingIntent>(parts.size)
            parts.indices.forEach { index ->
                sentIntents += callbackIntent(
                    receiverClass = SmsSentReceiver::class.java,
                    action = SmsSentReceiver.ACTION_SMS_SENT,
                    eventId = event.eventId,
                    partIndex = index,
                    requestCode = requestCode(event.eventId, index, false)
                )
                deliveryIntents += callbackIntent(
                    receiverClass = SmsDeliveryReceiver::class.java,
                    action = SmsDeliveryReceiver.ACTION_SMS_DELIVERED,
                    eventId = event.eventId,
                    partIndex = index,
                    requestCode = requestCode(event.eventId, index, true)
                )
            }

            if (parts.size == 1) {
                manager.sendTextMessage(
                    event.recipient,
                    null,
                    parts[0],
                    sentIntents[0],
                    deliveryIntents[0]
                )
            } else {
                manager.sendMultipartTextMessage(
                    event.recipient,
                    null,
                    parts,
                    sentIntents,
                    deliveryIntents
                )
            }
        } catch (error: Throwable) {
            PocEventStore.get(context).markDispatchFailure(
                event.eventId,
                "${error.javaClass.simpleName}: SMS dispatch failed"
            )
        }
    }

    private fun callbackIntent(
        receiverClass: Class<*>,
        action: String,
        eventId: String,
        partIndex: Int,
        requestCode: Int
    ): PendingIntent {
        val intent = Intent(context, receiverClass)
            .setAction(action)
            .putExtra(EXTRA_EVENT_ID, eventId)
            .putExtra(EXTRA_PART_INDEX, partIndex)
        return PendingIntent.getBroadcast(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun requestCode(eventId: String, partIndex: Int, delivery: Boolean): Int {
        val salt = if (delivery) 0x5A5A else 0x2C2C
        return (eventId.hashCode() * 31 + partIndex * 2 + salt) and 0x7fffffff
    }

    companion object {
        const val EXTRA_EVENT_ID = "event_id"
        const val EXTRA_PART_INDEX = "part_index"

        fun validate(recipient: String, body: String): String? = when {
            recipient.isBlank() -> "Recipient is required"
            body.isBlank() -> "Message body is required"
            recipient.any { it.isLetter() } -> "Recipient must be a phone number or short code"
            else -> null
        }
    }
}
