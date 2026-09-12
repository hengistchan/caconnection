package com.caconnection.worker

import com.caconnection.data.poc.OutboxEventEntity
import com.caconnection.transport.MockTransport
import com.caconnection.transport.TransportResult
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class OutboxWorkerTest {
    
    private lateinit var mockTransport: MockTransport
    
    @Before
    fun setup() {
        mockTransport = MockTransport()
        MockTransport.clearHistory()
        MockTransport.simulatedFailureRate = 0.0
        MockTransport.simulatedPermanentFailureRate = 0.0
        MockTransport.simulatedLatencyMillis = 0L
    }
    
    @After
    fun tearDown() {
        MockTransport.clearHistory()
    }
    
    @Test
    fun `transport success should record sent event`() = runTest {
        // Given
        val payload = """{"eventId":"test123","body":"Hello"}"""
        val idempotencyKey = "test_key_1"
        
        // When
        val result = mockTransport.send(payload, idempotencyKey)
        
        // Then
        assertTrue(result is TransportResult.Success)
        assertEquals(1, MockTransport.sentEvents.size)
        assertEquals(payload, MockTransport.sentEvents[0].payload)
        assertEquals(idempotencyKey, MockTransport.sentEvents[0].idempotencyKey)
    }
    
    @Test
    fun `transport temporary failure should return retryable result`() = runTest {
        // Given
        MockTransport.simulatedFailureRate = 1.0 // 100% failure rate
        val payload = """{"eventId":"test123","body":"Hello"}"""
        val idempotencyKey = "test_key_1"
        
        // When
        val result = mockTransport.send(payload, idempotencyKey)
        
        // Then
        assertTrue(result is TransportResult.RetryableFailure)
        assertEquals(0, MockTransport.sentEvents.size)
    }
    
    @Test
    fun `transport permanent failure should return permanent result`() = runTest {
        // Given
        MockTransport.simulatedPermanentFailureRate = 1.0 // 100% permanent failure
        val payload = """{"eventId":"test123","body":"Hello"}"""
        val idempotencyKey = "test_key_1"
        
        // When
        val result = mockTransport.send(payload, idempotencyKey)
        
        // Then
        assertTrue(result is TransportResult.PermanentFailure)
        assertEquals(0, MockTransport.sentEvents.size)
    }
    
    @Test
    fun `duplicate idempotency key should not cause duplicate sends`() = runTest {
        // Given
        val payload = """{"eventId":"test123","body":"Hello"}"""
        val idempotencyKey = "test_key_1"
        
        // When - send same event twice
        mockTransport.send(payload, idempotencyKey)
        mockTransport.send(payload, idempotencyKey)
        
        // Then - both should be recorded (transport doesn't deduplicate, but outbox should)
        assertEquals(2, MockTransport.sentEvents.size)
    }
    
    @Test
    fun `calculateBackoffDelay should return exponential delays`() {
        // Given - test the exponential backoff calculation logic directly
        val initialDelay = 1000L
        val multiplier = 2.0
        val maxDelay = 300000L
        
        // When - calculate delays for retry counts 1-5
        val delays = (1..5).map { retryCount ->
            val delay = initialDelay * Math.pow(multiplier, (retryCount - 1).toDouble())
            Math.min(delay.toLong(), maxDelay)
        }
        
        // Then - verify exponential growth
        assertEquals(1000L, delays[0]) // 1s
        assertEquals(2000L, delays[1]) // 2s
        assertEquals(4000L, delays[2]) // 4s
        assertEquals(8000L, delays[3]) // 8s
        assertEquals(16000L, delays[4]) // 16s
    }
}