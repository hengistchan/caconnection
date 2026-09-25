package com.caconnection.transport

import com.caconnection.worker.RemoteCommandScheduler
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class CommandStreamStateTest {
    @Before
    fun resetState() {
        CommandStreamState.reset()
    }

    @Test
    fun backoffDoublesAndCapsAtFiveMinutes() {
        assertEquals(15_000L, CommandStreamState.backoffDelayMillis(0))
        assertEquals(30_000L, CommandStreamState.backoffDelayMillis(1))
        assertEquals(60_000L, CommandStreamState.backoffDelayMillis(2))
        assertEquals(300_000L, CommandStreamState.backoffDelayMillis(6))
        assertEquals(300_000L, CommandStreamState.backoffDelayMillis(50))
    }

    @Test
    fun firstRetryAfterDisconnectWaitsOneInterval() {
        CommandStreamState.onConnected(1_000L)
        CommandStreamState.onDisconnected("boom")

        assertEquals(15_000L, CommandStreamState.nextReconnectDelayMillis())
        assertEquals(30_000L, CommandStreamState.nextReconnectDelayMillis())
    }

    @Test
    fun healthyConnectResetsTheBackoffSequence() {
        CommandStreamState.onDisconnected(null)
        CommandStreamState.nextReconnectDelayMillis()
        CommandStreamState.nextReconnectDelayMillis()

        CommandStreamState.onConnected(2_000L)
        CommandStreamState.onDisconnected(null)

        assertEquals(15_000L, CommandStreamState.nextReconnectDelayMillis())
    }

    @Test
    fun tracksConnectionAndLastEventForTheHealthPanel() {
        CommandStreamState.onConnected(10_000L)
        CommandStreamState.onCommandQueued(11_000L)

        assertTrue(CommandStreamState.connected)
        assertEquals(10_000L, CommandStreamState.lastConnectedAt)
        assertEquals(11_000L, CommandStreamState.lastEventAt)
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
