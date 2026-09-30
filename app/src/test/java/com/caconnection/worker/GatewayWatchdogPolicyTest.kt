package com.caconnection.worker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class GatewayWatchdogPolicyTest {
    @Test
    fun recoversWhenNoForegroundTickWasEverRecorded() {
        assertTrue(
            GatewayWatchdogPolicy.shouldRecover(
                now = 1_000_000L,
                lastWatchdogTickAt = 0L,
                oldestPendingAt = null
            )
        )
    }

    @Test
    fun staysQuietForFreshTickAndNoPendingOutbox() {
        assertFalse(
            GatewayWatchdogPolicy.shouldRecover(
                now = 1_000_000L,
                lastWatchdogTickAt = 990_000L,
                oldestPendingAt = null
            )
        )
    }

    @Test
    fun recoversForStaleOutboxEvenWhenForegroundTickIsFresh() {
        assertTrue(
            GatewayWatchdogPolicy.shouldRecover(
                now = 1_000_000L,
                lastWatchdogTickAt = 990_000L,
                oldestPendingAt = 1_000_000L - GatewayWatchdogPolicy.OUTBOX_WARNING_MS
            )
        )
    }

    @Test
    fun outboxLevelEscalatesWithBacklogAge() {
        assertEquals(
            GatewayWatchdogPolicy.OutboxLevel.OK,
            GatewayWatchdogPolicy.outboxLevel(now = 1_000_000L, oldestPendingAt = null)
        )
        assertEquals(
            GatewayWatchdogPolicy.OutboxLevel.OK,
            GatewayWatchdogPolicy.outboxLevel(
                now = 1_000_000L,
                oldestPendingAt = 1_000_000L - GatewayWatchdogPolicy.OUTBOX_WARNING_MS + 1L
            )
        )
        assertEquals(
            GatewayWatchdogPolicy.OutboxLevel.WARNING,
            GatewayWatchdogPolicy.outboxLevel(
                now = 1_000_000L,
                oldestPendingAt = 1_000_000L - GatewayWatchdogPolicy.OUTBOX_WARNING_MS
            )
        )
        assertEquals(
            GatewayWatchdogPolicy.OutboxLevel.CRITICAL,
            GatewayWatchdogPolicy.outboxLevel(
                now = 1_000_000L,
                oldestPendingAt = 1_000_000L - GatewayWatchdogPolicy.OUTBOX_CRITICAL_MS
            )
        )
    }

    @Test
    fun jitterStaysWithinFifthOfTheBaseInterval() {
        val base = GatewayWatchdogScheduler.NORMAL_INTERVAL_MS
        val random = Random(42)
        repeat(200) {
            val delay = GatewayWatchdogPolicy.withJitter(base, random)
            assertTrue("delay=$delay below base", delay >= base)
            assertTrue("delay=$delay above band", delay <= base + base / 5L)
        }
    }

    @Test
    fun jitterIsDeterministicForASeed() {
        assertEquals(
            GatewayWatchdogPolicy.withJitter(1_000L, Random(7)),
            GatewayWatchdogPolicy.withJitter(1_000L, Random(7))
        )
    }
}
