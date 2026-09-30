package com.caconnection.transport

import java.util.concurrent.atomic.AtomicInteger
import kotlin.random.Random

/**
 * Live state of the availability-layer command stream (ADR-003).
 *
 * The stream only changes command *latency*; correctness stays with the
 * claim/lease protocol. The health panel reads this to show whether the fast
 * path or the WorkManager fallback is carrying remote commands right now.
 */
object CommandStreamState {
    const val MIN_BACKOFF_MS = 15_000L
    const val MAX_BACKOFF_MS = 5 * 60_000L

    /**
     * Exponential step is capped below [MAX_BACKOFF_MS] so the jitter band
     * (up to a third of the base) still tops out at [MAX_BACKOFF_MS].
     */
    private val BASE_BACKOFF_CAP_MS = MAX_BACKOFF_MS * 3 / 4

    @Volatile
    var connected: Boolean = false
        private set

    @Volatile
    var lastConnectedAt: Long = 0L
        private set

    @Volatile
    var lastEventAt: Long = 0L
        private set

    @Volatile
    var lastHeartbeatAt: Long = 0L
        private set

    @Volatile
    var lastError: String? = null
        private set

    private val reconnectAttempts = AtomicInteger(0)

    fun onConnected(now: Long) {
        connected = true
        lastConnectedAt = now
        lastHeartbeatAt = now
        lastError = null
        reconnectAttempts.set(0)
    }

    fun onCommandQueued(now: Long) {
        lastEventAt = now
    }

    fun onHeartbeat(now: Long) {
        lastHeartbeatAt = now
    }

    fun onDisconnected(error: String?) {
        // lastConnectedAt is preserved on purpose: the health panel shows
        // "last online" even while the fast path is down.
        connected = false
        if (error != null) lastError = error
    }

    /**
     * Delay before the next connection attempt, then advance the backoff.
     * The first retry waits [MIN_BACKOFF_MS] plus jitter; a healthy connect
     * resets the sequence via [onConnected].
     */
    fun nextReconnectDelayMillis(random: Random = Random.Default): Long {
        val delay = jitteredBackoffDelayMillis(reconnectAttempts.get(), random)
        reconnectAttempts.incrementAndGet()
        return delay
    }

    fun reset() {
        connected = false
        lastConnectedAt = 0L
        lastEventAt = 0L
        lastHeartbeatAt = 0L
        lastError = null
        reconnectAttempts.set(0)
    }

    /**
     * Exponential reconnect backoff, capped. The deterministic step stays
     * testable on its own; [jitteredBackoffDelayMillis] is what the client
     * actually sleeps.
     */
    internal fun backoffDelayMillis(attempt: Int): Long {
        val exponent = attempt.coerceIn(0, 10)
        val delay = MIN_BACKOFF_MS shl exponent
        return delay.coerceAtMost(BASE_BACKOFF_CAP_MS)
    }

    /**
     * Spreads reconnects across devices after a shared outage: the band widens
     * by up to a third of the step (15-20s, 30-40s, 60-80s...) and the whole
     * delay still tops out at [MAX_BACKOFF_MS].
     */
    internal fun jitteredBackoffDelayMillis(attempt: Int, random: Random): Long {
        val base = backoffDelayMillis(attempt)
        return (base + random.nextLong(0L, base / 3L + 1L)).coerceAtMost(MAX_BACKOFF_MS)
    }
}
