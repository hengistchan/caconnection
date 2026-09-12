package com.caconnection.data.poc

import com.google.gson.Gson
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.UUID

object OutboxHelper {
    private val gson = Gson()

    /**
     * Creates the upload record that is committed in the same Room
     * transaction as its incoming SMS event.
     */
    fun createOutboxForIncoming(incomingEvent: IncomingSmsEventEntity): OutboxEventEntity {
        val now = System.currentTimeMillis()
        return OutboxEventEntity(
            UUID.randomUUID().toString(),
            generateIdempotencyKey(incomingEvent),
            incomingEvent.eventId,
            OutboxStatus.PENDING.name,
            0,
            now,
            now,
            now,
            incomingEvent.resolvedSubscriptionId,
            incomingEvent.resolvedSlotIndex,
            "INCOMING_SMS",
            gson.toJson(IncomingSmsPayload.fromEntity(incomingEvent)),
            null,
            null
        )
    }

    fun createLocalSelfTest(): OutboxEventEntity {
        val now = System.currentTimeMillis()
        val eventId = UUID.randomUUID().toString()
        return OutboxEventEntity(
            eventId,
            "selftest_$eventId",
            "SELF_TEST",
            OutboxStatus.PENDING.name,
            0,
            now,
            now,
            now,
            null,
            null,
            "LOCAL_SELF_TEST",
            """{"type":"LOCAL_SELF_TEST","createdAt":$now}""",
            null,
            null
        )
    }

    /**
     * The full SHA-256 digest avoids the silent collision risk of Java's
     * 32-bit hashCode. Slot/subscription are included so identical content
     * received by two physical lines is not collapsed.
     */
    private fun generateIdempotencyKey(event: IncomingSmsEventEntity): String {
        val canonical = listOf(
            event.originatingAddress.orEmpty(),
            event.receivedAt.toString(),
            event.body.orEmpty(),
            event.partCount.toString(),
            event.resolvedSubscriptionId?.toString().orEmpty(),
            event.resolvedSlotIndex?.toString().orEmpty()
        ).joinToString(separator = "") { value ->
            "${value.toByteArray(StandardCharsets.UTF_8).size}:$value"
        }
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(canonical.toByteArray(StandardCharsets.UTF_8))
            .joinToString(separator = "") { byte -> "%02x".format(byte) }
        return "sms_$digest"
    }

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
            fun fromEntity(entity: IncomingSmsEventEntity): IncomingSmsPayload =
                IncomingSmsPayload(
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

enum class OutboxStatus {
    PENDING,
    IN_PROGRESS,
    SUCCESS,
    RETRY,
    FAILED
}
