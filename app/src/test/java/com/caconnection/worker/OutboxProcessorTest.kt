package com.caconnection.worker

import com.caconnection.data.poc.OutboxEventEntity
import com.caconnection.data.poc.OutboxStatus
import com.caconnection.transport.Transport
import com.caconnection.transport.TransportResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class OutboxProcessorTest {
    @Test
    fun successMovesEventThroughInProgressToSuccess() = runTest {
        val statuses = mutableListOf<String>()
        val event = event()
        val processor = OutboxProcessor(
            transport = Transport { TransportResult.Success },
            now = { 1_000L }
        )

        val outcome = processor.process(event) { statuses += it.status }

        assertEquals(OutboxStatus.SUCCESS, outcome)
        assertEquals(
            listOf(OutboxStatus.IN_PROGRESS.name, OutboxStatus.SUCCESS.name),
            statuses
        )
        assertNull(event.lastError)
    }

    @Test
    fun retryableFailurePersistsRetryAndServerDelay() = runTest {
        val event = event()
        val processor = OutboxProcessor(
            transport = Transport {
                TransportResult.RetryableFailure("offline", 5_000L)
            },
            now = { 10_000L }
        )

        val outcome = processor.process(event) {}

        assertEquals(OutboxStatus.RETRY, outcome)
        assertEquals(OutboxStatus.RETRY.name, event.status)
        assertEquals(1, event.retryCount)
        assertEquals(15_000L, event.nextRetryAt)
        assertEquals("offline", event.lastError)
    }

    @Test
    fun retryableFailuresRemainDurableAfterTenAttempts() = runTest {
        val event = event().apply { retryCount = 9 }
        val processor = OutboxProcessor(
            transport = Transport {
                TransportResult.RetryableFailure("still offline")
            },
            now = { 20_000L }
        )

        val outcome = processor.process(event) {}

        assertEquals(OutboxStatus.RETRY, outcome)
        assertEquals(OutboxStatus.RETRY.name, event.status)
        assertEquals(10, event.retryCount)
        assertEquals(320_000L, event.nextRetryAt)
        assertEquals("still offline", event.lastError)
    }

    @Test
    fun retryCountDoesNotOverflow() {
        val decision = OutboxRetryPolicy.decide(
            currentRetryCount = Int.MAX_VALUE,
            now = 20_000L,
            error = "still offline"
        )

        assertEquals(OutboxStatus.RETRY, decision.status)
        assertEquals(Int.MAX_VALUE, decision.retryCount)
        assertEquals(320_000L, decision.nextRetryAt)
    }

    @Test
    fun missingPayloadFailsWithoutCallingTransport() = runTest {
        var called = false
        val event = event().apply { payloadData = null }
        val processor = OutboxProcessor(
            transport = Transport {
                called = true
                TransportResult.Success
            }
        )

        val outcome = processor.process(event) {}

        assertFalse(called)
        assertEquals(OutboxStatus.FAILED, outcome)
        assertEquals(OutboxStatus.FAILED.name, event.status)
        assertEquals("Missing payload", event.lastError)
    }

    @Test
    fun coroutineCancellationIsNotConvertedIntoRetry() = runTest {
        val event = event()
        val processor = OutboxProcessor(
            transport = Transport { throw CancellationException("cancelled") }
        )

        var cancellationObserved = false
        try {
            processor.process(event) {}
        } catch (_: CancellationException) {
            cancellationObserved = true
        }

        assertEquals(true, cancellationObserved)
        assertEquals(OutboxStatus.IN_PROGRESS.name, event.status)
    }

    @Test
    fun backoffUsesProductionPolicyAndCapsAtFiveMinutes() {
        assertEquals(1_000L, OutboxRetryPolicy.backoffDelay(1))
        assertEquals(2_000L, OutboxRetryPolicy.backoffDelay(2))
        assertEquals(16_000L, OutboxRetryPolicy.backoffDelay(5))
        assertEquals(300_000L, OutboxRetryPolicy.backoffDelay(20))
    }

    private fun event() = OutboxEventEntity(
        "outbox-1",
        "sms-key",
        "incoming-1",
        OutboxStatus.PENDING.name,
        0,
        0L,
        0L,
        0L,
        1,
        0,
        "INCOMING_SMS",
        "{}",
        null,
        null
    )
}
