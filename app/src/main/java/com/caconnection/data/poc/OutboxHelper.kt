package com.caconnection.data.poc

import com.google.gson.Gson
import java.util.UUID

/**
 * Helper class for creating and managing outbox events.
 */
object OutboxHelper {
    
    private val gson = Gson()
    
    /**
     * Create an outbox event for an incoming SMS.
     * Must be called within a database transaction with the incoming event.
     */
    fun createOutboxForIncoming(incomingEvent: IncomingSmsEventEntity): OutboxEventEntity {
        val idempotencyKey = generateIdempotencyKey(incomingEvent)
        val payload = IncomingSmsPayload.fromEntity(incomingEvent)
        val payloadJson = gson.toJson(payload)
        
        return OutboxEventEntity(
            UUID.randomUUID().toString(), // eventId
            idempotencyKey, // idempotencyKey
            incomingEvent.eventId, // incomingEventId
            "PENDING", // status
            0, // retryCount
            System.currentTimeMillis(), // nextRetryAt
            System.currentTimeMillis(), // createdAt
            System.currentTimeMillis(), // updatedAt
            incomingEvent.resolvedSubscriptionId, // subscriptionId
            incomingEvent.resolvedSlotIndex, // slotIndex
            "INCOMING_SMS", // payloadType
            payloadJson, // payloadData
            null, // lastError
            null // lastResultCode
        )
    }
    
    /**
     * Generate idempotency key for an incoming SMS event.
     * Key is based on: originating address + received timestamp + body hash
     * This prevents duplicate processing of the same SMS.
     */
    private fun generateIdempotencyKey(event: IncomingSmsEventEntity): String {
        val keyComponents = listOf(
            event.originatingAddress ?: "",
            event.receivedAt.toString(),
            event.body?.hashCode()?.toString() ?: ""
        )
        val rawKey = keyComponents.joinToString("|")
        return "sms_${rawKey.hashCode().toString(16)}"
    }
    
    /**
     * Data class representing the payload for an incoming SMS.
     */
    data class IncomingSmsPayload(
        val eventId: String,
        val originatingAddress: String?,
        val body: String?,
        val receivedAt: Long,
        val partCount: Int,
        val subscriptionId: Int?,
        val slotIndex: Int?,
        val resolutionMethod: String?,
        val resolutionConfidence: String?
    ) {
        companion object {
            fun fromEntity(entity: IncomingSmsEventEntity): IncomingSmsPayload {
                return IncomingSmsPayload(
                    eventId = entity.eventId,
                    originatingAddress = entity.originatingAddress,
                    body = entity.body,
                    receivedAt = entity.receivedAt,
                    partCount = entity.partCount,
                    subscriptionId = entity.resolvedSubscriptionId,
                    slotIndex = entity.resolvedSlotIndex,
                    resolutionMethod = entity.resolutionMethod,
                    resolutionConfidence = entity.resolutionConfidence
                )
            }
        }
    }
}