package com.caconnection.transport

import java.util.concurrent.atomic.AtomicInteger

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
    var lastError: String? = null
        private set

    private val reconnectAttempts = AtomicInteger(0)

    fun onConnected(now: Long) {
        connected = true
        lastConnectedAt = now
        lastError = null
        reconnectAttempts.set(0)
    }

    fun onCommandQueued(now: Long) {
        lastEventAt = now
    }

    fun onDisconnected(error: String?) {
        // lastConnectedAt is preserved on purpose: the health panel shows
        // "last online" even while the fast path is down.
        connected = false
        if (error != null) lastError = error
    }

    /**
     * Delay before the next connection attempt, then advance the backoff.
     * The first retry waits [MIN_BACKOFF_MS]; a healthy connect resets the
     * sequence via [onConnected].
     */
    fun nextReconnectDelayMillis(): Long {
        val delay = backoffDelayMillis(reconnectAttempts.get())
        reconnectAttempts.incrementAndGet()
        return delay
    }

    fun reset() {
        connected = false
        lastConnectedAt = 0L
        lastEventAt = 0L
        lastError = null
        reconnectAttempts.set(0)
    }

    /**
     * Exponential reconnect backoff, capped. Deterministic (no jitter) so the
     * fallback cadence is testable and predictable in diagnostics.
     */
    internal fun backoffDelayMillis(attempt: Int): Long {
        val exponent = attempt.coerceIn(0, 10)
        val delay = MIN_BACKOFF_MS shl exponent
        return delay.coerceAtMost(MAX_BACKOFF_MS)
    }
}
