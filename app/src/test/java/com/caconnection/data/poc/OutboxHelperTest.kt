package com.caconnection.data.poc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

class OutboxHelperTest {
    @Test
    fun createsPendingOutboxWithFullSha256IdempotencyKey() {
        val incoming = incoming()

        val outbox = OutboxHelper.createOutboxForIncoming(incoming)

        assertTrue(outbox.eventId.isNotBlank())
        assertTrue(outbox.idempotencyKey.matches(Regex("sms_[0-9a-f]{64}")))
        assertEquals(incoming.eventId, outbox.incomingEventId)
        assertEquals(OutboxStatus.PENDING.name, outbox.status)
        assertEquals(0, outbox.retryCount)
        assertEquals("INCOMING_SMS", outbox.payloadType)
        assertTrue(outbox.payloadData.contains(incoming.eventId))
    }

    @Test
    fun duplicateDeliveryAttemptGetsSameIdempotencyKey() {
        val first = incoming()
        val duplicate = incoming(
            eventId = UUID.randomUUID().toString(),
            originatingAddress = first.originatingAddress,
            body = first.body,
            receivedAt = first.receivedAt,
            subscriptionId = first.resolvedSubscriptionId,
            slotIndex = first.resolvedSlotIndex
        )

        assertEquals(
            OutboxHelper.createOutboxForIncoming(first).idempotencyKey,
            OutboxHelper.createOutboxForIncoming(duplicate).idempotencyKey
        )
    }

    @Test
    fun identicalContentOnDifferentSimGetsDifferentIdempotencyKey() {
        val first = incoming(subscriptionId = 1, slotIndex = 0)
        val second = incoming(
            eventId = UUID.randomUUID().toString(),
            originatingAddress = first.originatingAddress,
            body = first.body,
            receivedAt = first.receivedAt,
            subscriptionId = 2,
            slotIndex = 1
        )

        assertNotEquals(
            OutboxHelper.createOutboxForIncoming(first).idempotencyKey,
            OutboxHelper.createOutboxForIncoming(second).idempotencyKey
        )
    }

    @Test
    fun payloadContainsRequiredInboundFields() {
        val incoming = incoming()

        val payload = OutboxHelper.createOutboxForIncoming(incoming).payloadData

        assertTrue(payload.contains(incoming.eventId))
        assertTrue(payload.contains(incoming.originatingAddress))
        assertTrue(payload.contains(incoming.body))
        assertTrue(payload.contains(incoming.receivedAt.toString()))
        assertTrue(payload.contains("\"subscriptionId\":1"))
        assertTrue(payload.contains("\"slotIndex\":0"))
    }

    @Test
    fun selfTestContainsNoSmsContentAndStartsPending() {
        val outbox = OutboxHelper.createLocalSelfTest()

        assertEquals("SELF_TEST", outbox.incomingEventId)
        assertEquals("LOCAL_SELF_TEST", outbox.payloadType)
        assertEquals(OutboxStatus.PENDING.name, outbox.status)
        assertTrue(outbox.idempotencyKey.startsWith("selftest_"))
        assertTrue(outbox.payloadData.contains("LOCAL_SELF_TEST"))
    }

    @Test
    fun notificationPayloadIsMetadataOnly() {
        val event = NotificationEventEntity(
            "notification-event",
            "POSTED",
            "com.example.alerts",
            42,
            "key-hash",
            1_000L,
            1_100L,
            "alerts",
            "msg",
            true,
            true,
            12,
            34,
            null,
            "METADATA_ONLY"
        )

        val outbox = OutboxHelper.createOutboxForNotification(event)

        assertTrue(outbox.idempotencyKey.matches(Regex("notification_[0-9a-f]{64}")))
        assertEquals(event.eventId, outbox.incomingEventId)
        assertEquals("NOTIFICATION", outbox.payloadType)
        assertTrue(outbox.payloadData.contains("com.example.alerts"))
        assertTrue(outbox.payloadData.contains("\"titleLength\":12"))
        assertTrue(outbox.payloadData.contains("\"redactionPolicy\":\"METADATA_ONLY\""))
    }

    @Test
    fun callPayloadContainsSimAndNoCallerIdentity() {
        val event = CallEventEntity(
            "call-event",
            "call-session",
            2,
            1,
            "RINGING",
            2_000L,
            false
        )

        val outbox = OutboxHelper.createOutboxForCall(event)

        assertTrue(outbox.idempotencyKey.matches(Regex("call_[0-9a-f]{64}")))
        assertEquals(event.eventId, outbox.incomingEventId)
        assertEquals("CALL_STATE", outbox.payloadType)
        assertEquals(2, outbox.subscriptionId)
        assertEquals(1, outbox.slotIndex)
        assertTrue(outbox.payloadData.contains("\"state\":\"RINGING\""))
        assertTrue(outbox.payloadData.contains("\"subscriptionId\":2"))
        assertTrue(outbox.payloadData.contains("\"slotIndex\":1"))
        assertTrue(!outbox.payloadData.contains("phoneNumber"))
        assertTrue(!outbox.payloadData.contains("caller"))
    }

    private fun incoming(
        eventId: String = UUID.randomUUID().toString(),
        originatingAddress: String = "+1234567890",
        body: String = "Test message",
        receivedAt: Long = 1_789_189_395_000L,
        subscriptionId: Int? = 1,
        slotIndex: Int? = 0
    ) = IncomingSmsEventEntity(
        eventId,
        "android.provider.Telephony.SMS_RECEIVED",
        originatingAddress,
        body,
        receivedAt,
        receivedAt + 2_000L,
        1,
        subscriptionId,
        slotIndex,
        "OEM_SUBSCRIPTION_EXTRA",
        "HIGH",
        "Test",
        "{}",
        "NOT_APPLICABLE",
        null,
        null
    )
}
