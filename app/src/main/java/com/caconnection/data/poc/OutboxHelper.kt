package com.caconnection.data.poc

import com.google.gson.Gson
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.UUID

object OutboxHelper {
    private val gson = Gson()

    /**
     * Creates the upload record that is committed in the same Room
     * transaction as its incoming SMS event. The idempotency key must be the
     * one computed at spool stage time — never recomputed from entity state
     * that changes between staging and SIM resolution.
     */
    fun createOutboxForIncoming(
        incomingEvent: IncomingSmsEventEntity,
        idempotencyKey: String
    ): OutboxEventEntity {
        val now = System.currentTimeMillis()
        return OutboxEventEntity(
            UUID.randomUUID().toString(),
            idempotencyKey,
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

    fun createDeviceState(payload: DeviceStatePayload): OutboxEventEntity {
        val eventId = UUID.randomUUID().toString()
        val payloadJson = gson.toJson(payload)
        return OutboxEventEntity(
            eventId,
            "device_state_${sha256(payloadJson)}",
            "DEVICE_STATE",
            OutboxStatus.PENDING.name,
            0,
            payload.observedAt,
            payload.observedAt,
            payload.observedAt,
            null,
            null,
            "DEVICE_STATE",
            payloadJson,
            null,
            null
        )
    }

    fun createOutboxForNotification(
        event: NotificationEventEntity
    ): OutboxEventEntity {
        val now = System.currentTimeMillis()
        return OutboxEventEntity(
            UUID.randomUUID().toString(),
            "notification_${sha256(event.eventId)}",
            event.eventId,
            OutboxStatus.PENDING.name,
            0,
            now,
            now,
            now,
            null,
            null,
            "NOTIFICATION",
            gson.toJson(NotificationPayload.fromEntity(event)),
            null,
            null
        )
    }

    fun createOutboxForCall(event: CallEventEntity): OutboxEventEntity {
        val now = System.currentTimeMillis()
        return OutboxEventEntity(
            UUID.randomUUID().toString(),
            "call_${sha256(event.eventId)}",
            event.eventId,
            OutboxStatus.PENDING.name,
            0,
            now,
            now,
            now,
            event.subscriptionId,
            event.slotIndex,
            "CALL_STATE",
            gson.toJson(CallPayload.fromEntity(event)),
            null,
            null
        )
    }

    fun createOutboxForCallIdentity(
        event: CallIdentityEventEntity
    ): OutboxEventEntity {
        val now = System.currentTimeMillis()
        return OutboxEventEntity(
            UUID.randomUUID().toString(),
            "call_identity_${sha256(event.eventId)}",
            event.eventId,
            OutboxStatus.PENDING.name,
            0,
            now,
            now,
            now,
            event.resolvedSubscriptionId,
            event.resolvedSlotIndex,
            "CALL_IDENTITY",
            gson.toJson(CallIdentityPayload.fromEntity(event)),
            null,
            null
        )
    }

    fun createOutboxForOutgoingStatus(
        event: OutgoingSmsEventEntity
    ): OutboxEventEntity? {
        val commandId = event.remoteCommandId ?: return null
        val now = System.currentTimeMillis()
        val statusKey = listOf(
            commandId,
            event.status,
            event.updatedAt,
            event.sentPartCount,
            event.deliveredPartCount,
            event.failedPartCount,
            event.lastResultCode
        ).joinToString("|")
        return OutboxEventEntity(
            UUID.randomUUID().toString(),
            "outbound_status_${sha256(statusKey)}",
            commandId,
            OutboxStatus.PENDING.name,
            0,
            now,
            now,
            now,
            event.requestedSubscriptionId,
            event.requestedSlotIndex,
            "OUTBOUND_SMS_STATUS",
            gson.toJson(OutgoingSmsStatusPayload.fromEntity(event)),
            null,
            null
        )
    }

    /**
     * Stable content key for an incoming SMS. Only immutable broadcast facts
     * are hashed: never values derived from live subscription lookups, which
     * can differ between the manifest receiver, the runtime fallback and a
     * spool replay of the same message. The full SHA-256 digest avoids the
     * silent collision risk of Java's 32-bit hashCode. Slot/subscription are
     * included so identical content received by two physical lines is not
     * collapsed.
     */
    fun incomingIdempotencyKey(
        originatingAddress: String?,
        receivedAt: Long,
        body: String?,
        partCount: Int,
        subscriptionId: Int?,
        slotIndex: Int?
    ): String {
        val canonical = listOf(
            originatingAddress.orEmpty(),
            receivedAt.toString(),
            body.orEmpty(),
            partCount.toString(),
            subscriptionId?.toString().orEmpty(),
            slotIndex?.toString().orEmpty()
        ).joinToString(separator = "") { value ->
            "${value.toByteArray(StandardCharsets.UTF_8).size}:$value"
        }
        return "sms_${sha256(canonical)}"
    }

    /**
     * Legacy derivation used only to replay spool entries staged before the
     * key was persisted alongside them.
     */
    fun generateIdempotencyKey(event: IncomingSmsEventEntity): String =
        incomingIdempotencyKey(
            event.originatingAddress,
            event.receivedAt,
            event.body,
            event.partCount,
            event.resolvedSubscriptionId,
            event.resolvedSlotIndex
        )

    private fun sha256(value: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(StandardCharsets.UTF_8))
            .joinToString(separator = "") { byte -> "%02x".format(byte) }

    data class IncomingSmsPayload(
        val eventId: String,
        val action: String?,
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
                    action = when (entity.action) {
                        android.provider.Telephony.Sms.Intents.SMS_RECEIVED_ACTION ->
                            "SMS_RECEIVED"
                        android.provider.Telephony.Sms.Intents.SMS_DELIVER_ACTION ->
                            "SMS_DELIVER"
                        else -> null
                    },
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

    data class DeviceStateLine(
        val slotIndex: Int,
        val subscriptionId: Int?,
        val carrierName: String?,
        val displayName: String?,
        val active: Boolean
    )

    data class DeviceStatePayload(
        val observedAt: Long,
        val appVersion: String,
        val versionCode: Int,
        val targetSdk: Int,
        val androidVersion: String,
        val manufacturer: String,
        val model: String,
        val receiveMode: String,
        val defaultSmsRole: Boolean,
        val receiveSmsGranted: Boolean,
        val sendSmsGranted: Boolean,
        val readPhoneStateGranted: Boolean,
        val lines: List<DeviceStateLine>,
        val receiverInvokedAt: Long? = null,
        val receiverInvokedAction: String? = null,
        val receiverParseFailureAt: Long? = null,
        val receiverParseFailureReason: String? = null
    )

    data class NotificationPayload(
        val eventId: String,
        val eventType: String,
        val sourcePackage: String,
        val notificationId: Int,
        val notificationKeyHash: String?,
        val postedAt: Long,
        val observedAt: Long,
        val channelId: String?,
        val category: String?,
        val title: String?,
        val body: String?,
        val titleExposed: Boolean,
        val textExposed: Boolean,
        val titleLength: Int,
        val textLength: Int,
        val removalReason: Int?,
        val redactionPolicy: String
    ) {
        companion object {
            fun fromEntity(entity: NotificationEventEntity) =
                NotificationPayload(
                    eventId = entity.eventId,
                    eventType = entity.eventType,
                    sourcePackage = entity.sourcePackage,
                    notificationId = entity.notificationId,
                    notificationKeyHash = entity.notificationKeyHash,
                    postedAt = entity.postedAt,
                    observedAt = entity.observedAt,
                    channelId = entity.channelId,
                    category = entity.category,
                    title = entity.title,
                    body = entity.body,
                    titleExposed = entity.titleExposed,
                    textExposed = entity.textExposed,
                    titleLength = entity.titleLength,
                    textLength = entity.textLength,
                    removalReason = entity.removalReason,
                    redactionPolicy = entity.redactionPolicy
                )
        }
    }

    data class CallPayload(
        val eventId: String,
        val sessionId: String,
        val subscriptionId: Int,
        val slotIndex: Int,
        val state: String,
        val observedAt: Long,
        val initialSnapshot: Boolean
    ) {
        companion object {
            fun fromEntity(entity: CallEventEntity) =
                CallPayload(
                    eventId = entity.eventId,
                    sessionId = entity.sessionId,
                    subscriptionId = entity.subscriptionId,
                    slotIndex = entity.slotIndex,
                    state = entity.state,
                    observedAt = entity.observedAt,
                    initialSnapshot = entity.initialSnapshot
                )
        }
    }

    data class CallIdentityPayload(
        val eventId: String,
        val telecomCallIdHash: String?,
        val callerAddress: String?,
        val callerDisplayName: String?,
        val handlePresentation: Int,
        val displayNamePresentation: Int,
        val phoneAccountId: String?,
        val subscriptionId: Int?,
        val slotIndex: Int?,
        val resolutionMethod: String?,
        val resolutionConfidence: String?,
        val verificationStatus: Int,
        val observedAt: Long,
        val respondedAt: Long,
        val decision: String
    ) {
        companion object {
            fun fromEntity(entity: CallIdentityEventEntity) =
                CallIdentityPayload(
                    eventId = entity.eventId,
                    telecomCallIdHash = entity.telecomCallIdHash,
                    callerAddress = entity.callerAddress,
                    callerDisplayName = entity.callerDisplayName,
                    handlePresentation = entity.handlePresentation,
                    displayNamePresentation = entity.displayNamePresentation,
                    phoneAccountId = entity.phoneAccountId,
                    subscriptionId = entity.resolvedSubscriptionId,
                    slotIndex = entity.resolvedSlotIndex,
                    resolutionMethod = entity.resolutionMethod,
                    resolutionConfidence = entity.resolutionConfidence,
                    verificationStatus = entity.verificationStatus,
                    observedAt = entity.observedAt,
                    respondedAt = entity.respondedAt,
                    decision = entity.decision
                )
        }
    }

    data class OutgoingSmsStatusPayload(
        val commandId: String,
        val status: String,
        val updatedAt: Long,
        val resultCode: Int?,
        val errorDetail: String?
    ) {
        companion object {
            fun fromEntity(entity: OutgoingSmsEventEntity) =
                OutgoingSmsStatusPayload(
                    commandId = requireNotNull(entity.remoteCommandId),
                    status = entity.status,
                    updatedAt = entity.updatedAt,
                    resultCode = entity.lastResultCode,
                    errorDetail = entity.errorDetail?.take(256)
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
