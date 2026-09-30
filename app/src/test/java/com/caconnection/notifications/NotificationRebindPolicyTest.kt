package com.caconnection.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationRebindPolicyTest {
    @Test
    fun firstAttemptIsImmediate() {
        assertEquals(0L, NotificationRebindPolicy.delayMs(attempts = 0))
    }

    @Test
    fun secondAttemptWaitsThirtySeconds() {
        assertEquals(
            NotificationRebindPolicy.SECOND_ATTEMPT_DELAY_MS,
            NotificationRebindPolicy.delayMs(attempts = 1)
        )
    }

    @Test
    fun thirdAttemptWaitsTwoMinutes() {
        assertEquals(
            NotificationRebindPolicy.THIRD_ATTEMPT_DELAY_MS,
            NotificationRebindPolicy.delayMs(attempts = 2)
        )
    }

    @Test
    fun laterAttemptsAreCappedAtFifteenMinutes() {
        assertEquals(
            NotificationRebindPolicy.MAX_DELAY_MS,
            NotificationRebindPolicy.delayMs(attempts = 3)
        )
        assertEquals(
            NotificationRebindPolicy.MAX_DELAY_MS,
            NotificationRebindPolicy.delayMs(attempts = 40)
        )
    }

    @Test
    fun delayIsMonotonicallyNonDecreasing() {
        var previous = 0L
        for (attempts in 0..10) {
            val delay = NotificationRebindPolicy.delayMs(attempts)
            assertTrue("delay=$delay decreased at attempts=$attempts", delay >= previous)
            previous = delay
        }
    }

    @Test
    fun pendingLeaseIsShorterThanEscalatedRetryDelay() {
        assertTrue(
            NotificationRebindPolicy.REQUEST_PENDING_LEASE_MS <
                NotificationRebindPolicy.MAX_DELAY_MS
        )
    }
}
