package com.caconnection.data.poc

import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class OutboxHelperTest {
    
    @Test
    fun `createOutboxForIncoming should generate valid outbox event`() {
        // Given
        val incomingEvent = createTestIncomingEvent()
        
        // When
        val outboxEvent = OutboxHelper.createOutboxForIncoming(incomingEvent)
        
        // Then
        assertNotNull(outboxEvent.eventId)
        assertTrue(outboxEvent.eventId.isNotBlank())
        assertNotNull(outboxEvent.idempotencyKey)
        assertTrue(outboxEvent.idempotencyKey.startsWith("sms_"))
        assertEquals(incomingEvent.eventId, outboxEvent.incomingEventId)
        assertEquals("PENDING", outboxEvent.status)
        assertEquals(0, outboxEvent.retryCount)
        assertEquals("INCOMING_SMS", outboxEvent.payloadType)
        assertNotNull(outboxEvent.payloadData)
        assertTrue(outboxEvent.payloadData!!.contains(incomingEvent.eventId))
    }
    
    @Test
    fun `idempotency key should be same for duplicate messages`() {
        // Given
        val incomingEvent1 = createTestIncomingEvent()
        val incomingEvent2 = createTestIncomingEvent(
            eventId = UUID.randomUUID().toString(), // Different event ID
            originatingAddress = incomingEvent1.originatingAddress,
            body = incomingEvent1.body,
            receivedAt = incomingEvent1.receivedAt
        )
        
        // When
        val outbox1 = OutboxHelper.createOutboxForIncoming(incomingEvent1)
        val outbox2 = OutboxHelper.createOutboxForIncoming(incomingEvent2)
        
        // Then - same idempotency key for same message content
        assertEquals(outbox1.idempotencyKey, outbox2.idempotencyKey)
    }
    
    @Test
    fun `idempotency key should be different for different messages`() {
        // Given
        val incomingEvent1 = createTestIncomingEvent()
        val incomingEvent2 = createTestIncomingEvent(
            originatingAddress = "+1987654321",
            body = "Different message",
            receivedAt = System.currentTimeMillis() + 1000
        )
        
        // When
        val outbox1 = OutboxHelper.createOutboxForIncoming(incomingEvent1)
        val outbox2 = OutboxHelper.createOutboxForIncoming(incomingEvent2)
        
        // Then - different idempotency key for different messages
        assertNotEquals(outbox1.idempotencyKey, outbox2.idempotencyKey)
    }
    
    @Test
    fun `idempotency key should be different for same message at different times`() {
        // Given
        val incomingEvent1 = createTestIncomingEvent()
        val incomingEvent2 = createTestIncomingEvent(
            receivedAt = incomingEvent1.receivedAt + 1000 // Different timestamp
        )
        
        // When
        val outbox1 = OutboxHelper.createOutboxForIncoming(incomingEvent1)
        val outbox2 = OutboxHelper.createOutboxForIncoming(incomingEvent2)
        
        // Then - different idempotency key for different timestamps
        assertNotEquals(outbox1.idempotencyKey, outbox2.idempotencyKey)
    }
    
    @Test
    fun `payload should contain all required fields`() {
        // Given
        val incomingEvent = createTestIncomingEvent()
        
        // When
        val outboxEvent = OutboxHelper.createOutboxForIncoming(incomingEvent)
        
        // Then
        val payload = outboxEvent.payloadData!!
        assertTrue(payload.contains(incomingEvent.eventId))
        assertTrue(payload.contains(incomingEvent.originatingAddress))
        assertTrue(payload.contains(incomingEvent.body))
        assertTrue(payload.contains(incomingEvent.receivedAt.toString()))
    }
    
    private fun createTestIncomingEvent(
        eventId: String = UUID.randomUUID().toString(),
        originatingAddress: String = "+1234567890",
        body: String = "Test message",
        receivedAt: Long = System.currentTimeMillis()
    ): IncomingSmsEventEntity {
        return IncomingSmsEventEntity(
            eventId, // eventId
            "android.provider.Telephony.SMS_RECEIVED", // action
            originatingAddress, // originatingAddress
            body, // body
            receivedAt, // receivedAt
            System.currentTimeMillis(), // persistedAt
            1, // partCount
            1, // resolvedSubscriptionId
            0, // resolvedSlotIndex
            "DEFAULT", // resolutionMethod
            "HIGH", // resolutionConfidence
            "Test", // resolutionNotes
            "{}", // rawExtras
            "NOT_APPLICABLE", // providerWriteStatus
            null, // providerUri
            null // providerWriteError
        )
    }
}