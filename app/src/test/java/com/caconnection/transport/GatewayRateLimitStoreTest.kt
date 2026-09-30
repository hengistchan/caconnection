package com.caconnection.transport

import org.junit.Assert.assertEquals
import org.junit.Test

class GatewayRateLimitStoreTest {
    @Test
    fun transientFailureCooldownIsLongerThanRequestSpacing() {
        org.junit.Assert.assertTrue(
            GatewayRateLimitStore.TRANSIENT_FAILURE_COOLDOWN_MS >
                GatewayRateLimitStore.REQUEST_SPACING_MS
        )
    }

    @Test
    fun cooldownUsesSlidingWindowFloor() {
        assertEquals(
            GatewayRateLimitStore.MIN_COOLDOWN_MS,
            GatewayRateLimitStore.effectiveDelayMillis(1_000L)
        )
        assertEquals(
            GatewayRateLimitStore.MIN_COOLDOWN_MS,
            GatewayRateLimitStore.effectiveDelayMillis(null)
        )
        assertEquals(
            90_000L,
            GatewayRateLimitStore.effectiveDelayMillis(90_000L)
        )
    }

    @Test
    fun cooldownCapsUntrustedServerDelay() {
        assertEquals(
            10 * 60_000L,
            GatewayRateLimitStore.effectiveDelayMillis(Long.MAX_VALUE)
        )
    }
}
