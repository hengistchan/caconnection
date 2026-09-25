package com.caconnection.transport

import org.junit.Assert.assertEquals
import org.junit.Test

class ConnectionHealthPolicyTest {
    @Test
    fun unknownBeforeFirstAttempt() {
        assertEquals(
            ConnectionHealth.UNKNOWN,
            ConnectionHealthPolicy.evaluate(0L, 0L, 0, 0L)
        )
    }

    @Test
    fun connectedAfterSuccess() {
        assertEquals(
            ConnectionHealth.CONNECTED,
            ConnectionHealthPolicy.evaluate(1_000L, 0L, 0, 1_000L)
        )
    }

    @Test
    fun degradedBeforeFailureThreshold() {
        assertEquals(
            ConnectionHealth.DEGRADED,
            ConnectionHealthPolicy.evaluate(1_000L, 2_000L, 2, 2_100L)
        )
    }

    @Test
    fun failureThresholdStillNeedsSustainedOutage() {
        assertEquals(
            ConnectionHealth.DEGRADED,
            ConnectionHealthPolicy.evaluate(1_000L, 2_000L, 3, 2_100L)
        )
    }

    @Test
    fun disconnectedAfterSustainedFailures() {
        assertEquals(
            ConnectionHealth.DISCONNECTED,
            ConnectionHealthPolicy.evaluate(
                1_000L,
                2_000L,
                3,
                2_000L + ConnectionHealthPolicy.DISCONNECTED_MIN_DURATION_MS
            )
        )
    }
}
