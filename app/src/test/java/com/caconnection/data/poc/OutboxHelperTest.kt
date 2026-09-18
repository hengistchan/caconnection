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
        assertTrue(payload.contains("\"action\":\"SMS_RECEIVED\""))
    }

    @Test
    fun deviceStateContainsCapabilitiesAndNoSubscriberIdentifiers() {
        val outbox = OutboxHelper.createDeviceState(
            OutboxHelper.DeviceStatePayload(
                observedAt = 5_000L,
                appVersion = "1.0.0",
                versionCode = 10,
                targetSdk = 37,
                androidVersion = "16",
                manufacturer = "Example",
                model = "Gateway",
                receiveMode = "OBSERVER",
                defaultSmsRole = false,
                receiveSmsGranted = true,
                sendSmsGranted = true,
                readPhoneStateGranted = true,
                lines = listOf(
                    OutboxHelper.DeviceStateLine(
                        slotIndex = 0,
                        subscriptionId = 42,
                        carrierName = "Carrier",
                        displayName = "SIM 1",
                        active = true
                    )
                ),
                receiverInvokedAt = 4_900L,
                receiverInvokedAction = "SMS_RECEIVED",
                receiverParseFailureAt = 4_950L,
                receiverParseFailureReason = "NO_MESSAGES"
            )
        )

        assertEquals("DEVICE_STATE", outbox.payloadType)
        assertTrue(outbox.idempotencyKey.matches(Regex("device_state_[0-9a-f]{64}")))
        assertTrue(outbox.payloadData.contains("\"targetSdk\":37"))
        assertTrue(outbox.payloadData.contains("\"receiveMode\":\"OBSERVER\""))
        assertTrue(outbox.payloadData.contains("\"slotIndex\":0"))
        assertTrue(outbox.payloadData.contains("\"receiverInvokedAt\":4900"))
        assertTrue(
            outbox.payloadData.contains(
                "\"receiverInvokedAction\":\"SMS_RECEIVED\""
            )
        )
        assertTrue(
            outbox.payloadData.contains(
                "\"receiverParseFailureReason\":\"NO_MESSAGES\""
            )
        )
        assertTrue(!outbox.payloadData.contains("phoneNumber"))
        assertTrue(!outbox.payloadData.contains("iccid", ignoreCase = true))
        assertTrue(!outbox.payloadData.contains("imsi", ignoreCase = true))
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
    fun notificationPayloadContainsTitleAndBody() {
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
            "Bank alert",
            "Code 123456",
            true,
            true,
            12,
            34,
            null,
            "ALLOWLIST_CONTENT"
        )

        val outbox = OutboxHelper.createOutboxForNotification(event)

        assertTrue(outbox.idempotencyKey.matches(Regex("notification_[0-9a-f]{64}")))
        assertEquals(event.eventId, outbox.incomingEventId)
        assertEquals("NOTIFICATION", outbox.payloadType)
        assertTrue(outbox.payloadData.contains("com.example.alerts"))
        assertTrue(outbox.payloadData.contains("\"title\":\"Bank alert\""))
        assertTrue(outbox.payloadData.contains("\"body\":\"Code 123456\""))
        assertTrue(outbox.payloadData.contains("\"titleLength\":12"))
        assertTrue(outbox.payloadData.contains("\"redactionPolicy\":\"ALLOWLIST_CONTENT\""))
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

    @Test
    fun callIdentityPayloadContainsCallerAndResolvedSim() {
        val event = CallIdentityEventEntity(
            "identity-event",
            "telecom-id-hash",
            "+15551234567",
            "Network supplied name",
            1,
            1,
            "2",
            2,
            1,
            "PHONE_ACCOUNT_ID",
            "HIGH",
            "Exact match",
            1,
            3_000L,
            3_010L,
            "ALLOW"
        )

        val outbox = OutboxHelper.createOutboxForCallIdentity(event)

        assertTrue(
            outbox.idempotencyKey.matches(Regex("call_identity_[0-9a-f]{64}"))
        )
        assertEquals("CALL_IDENTITY", outbox.payloadType)
        assertEquals(2, outbox.subscriptionId)
        assertEquals(1, outbox.slotIndex)
        assertTrue(outbox.payloadData.contains("+15551234567"))
        assertTrue(outbox.payloadData.contains("\"decision\":\"ALLOW\""))
        assertTrue(outbox.payloadData.contains("\"resolutionConfidence\":\"HIGH\""))
    }

    @Test
    fun remoteOutgoingStatusContainsNoRecipientOrMessageBody() {
        val event = OutgoingSmsEventEntity(
            "remote-command-0001",
            "+15551234567",
            "Sensitive remote message",
            4_000L,
            4_100L,
            2,
            1,
            "Carrier",
            "remote-command-0001",
            OutgoingStatus.SENT_TO_MODEM.name,
            1,
            1,
            0,
            0,
            -1,
            null,
            "NOT_ATTEMPTED",
            null,
            null
        )

        val outbox = requireNotNull(
            OutboxHelper.createOutboxForOutgoingStatus(event)
        )

        assertEquals("OUTBOUND_SMS_STATUS", outbox.payloadType)
        assertEquals("remote-command-0001", outbox.incomingEventId)
        assertTrue(outbox.payloadData.contains("remote-command-0001"))
        assertTrue(outbox.payloadData.contains("SENT_TO_MODEM"))
        assertTrue(!outbox.payloadData.contains("+15551234567"))
        assertTrue(!outbox.payloadData.contains("Sensitive remote message"))
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
