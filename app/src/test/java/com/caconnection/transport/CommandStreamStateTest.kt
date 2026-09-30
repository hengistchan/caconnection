package com.caconnection.transport

import com.caconnection.worker.RemoteCommandScheduler
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import kotlin.random.Random

class CommandStreamStateTest {
    @Before
    fun resetState() {
        CommandStreamState.reset()
    }

    @Test
    fun backoffDoublesAndCapsBelowTheJitteredCeiling() {
        assertEquals(15_000L, CommandStreamState.backoffDelayMillis(0))
        assertEquals(30_000L, CommandStreamState.backoffDelayMillis(1))
        assertEquals(60_000L, CommandStreamState.backoffDelayMillis(2))
        // Base steps stop at three quarters of the ceiling so the jitter band
        // (up to a third) still tops out at MAX_BACKOFF_MS.
        assertEquals(225_000L, CommandStreamState.backoffDelayMillis(6))
        assertEquals(225_000L, CommandStreamState.backoffDelayMillis(50))
    }

    @Test
    fun jitterStaysWithinTheBandAndBelowTheCeiling() {
        val random = Random(42)
        for (attempt in 0..12) {
            val base = CommandStreamState.backoffDelayMillis(attempt)
            repeat(20) {
                val delay = CommandStreamState.jitteredBackoffDelayMillis(attempt, random)
                assertTrue("delay=$delay below base=$base", delay >= base)
                assertTrue(
                    "delay=$delay above band base=$base",
                    delay <= base + base / 3L
                )
                assertTrue("delay=$delay above ceiling", delay <= CommandStreamState.MAX_BACKOFF_MS)
            }
        }
    }

    @Test
    fun firstRetryAfterDisconnectWaitsOneInterval() {
        val random = Random(7)
        CommandStreamState.onConnected(1_000L)
        CommandStreamState.onDisconnected("boom")

        assertInBand(15_000L, CommandStreamState.nextReconnectDelayMillis(random))
        assertInBand(30_000L, CommandStreamState.nextReconnectDelayMillis(random))
    }

    @Test
    fun healthyConnectResetsTheBackoffSequence() {
        val random = Random(11)
        CommandStreamState.onDisconnected(null)
        CommandStreamState.nextReconnectDelayMillis(random)
        CommandStreamState.nextReconnectDelayMillis(random)

        CommandStreamState.onConnected(2_000L)
        CommandStreamState.onDisconnected(null)

        assertInBand(15_000L, CommandStreamState.nextReconnectDelayMillis(random))
    }

    private fun assertInBand(base: Long, delay: Long) {
        assertTrue("delay=$delay below base=$base", delay >= base)
        assertTrue("delay=$delay above band base=$base", delay <= base + base / 3L)
    }

    @Test
    fun tracksConnectionAndLastEventForTheHealthPanel() {
        CommandStreamState.onConnected(10_000L)
        CommandStreamState.onHeartbeat(10_500L)
        CommandStreamState.onCommandQueued(11_000L)

        assertTrue(CommandStreamState.connected)
        assertEquals(10_000L, CommandStreamState.lastConnectedAt)
        assertEquals(11_000L, CommandStreamState.lastEventAt)
        assertEquals(10_500L, CommandStreamState.lastHeartbeatAt)
        assertNull(CommandStreamState.lastError)

        CommandStreamState.onDisconnected("HTTP 502")

        assertFalse(CommandStreamState.connected)
        assertEquals("HTTP 502", CommandStreamState.lastError)
        // "Last online" survives the disconnect for diagnostics.
        assertEquals(10_000L, CommandStreamState.lastConnectedAt)
    }

    /**
     * ADR-003: polling cadence follows the stream — fast fallback only while
     * the push channel is down; WorkManager reconciles sparsely while up.
     */
    @Test
    fun pollDelayFollowsStreamAvailability() {
        assertEquals(
            RemoteCommandScheduler.NORMAL_POLL_DELAY_MS,
            RemoteCommandScheduler.nextPollDelay()
        )

        CommandStreamState.onConnected(1L)

        assertEquals(
            RemoteCommandScheduler.RECONCILE_POLL_DELAY_MS,
            RemoteCommandScheduler.nextPollDelay()
        )
    }
}
