package com.caconnection.transport

import android.content.Context
import android.util.Log
import androidx.core.content.edit
import kotlin.math.max

/**
 * Process-independent cooldown shared by every Gateway HTTP channel.
 *
 * The server uses a 60-second sliding window. Persisting the deadline prevents
 * already queued WorkManager jobs and a reconnecting SSE thread from each
 * issuing another request while the same device/IP budget is exhausted.
 */
object GatewayRateLimitStore {
    private const val TAG = "GatewayRateLimit"
    private const val PREFERENCES = "gateway_rate_limit"
    private const val RATE_LIMITED_UNTIL = "rate_limited_until"
    private const val NEXT_REQUEST_NOT_BEFORE = "next_request_not_before"
    private const val LAST_SOURCE = "last_source"

    // The server window is 60 seconds. Keep a small boundary margin because
    // Retry-After is rounded to whole seconds and device/server clocks differ.
    const val MIN_COOLDOWN_MS = 65_000L
    const val REQUEST_SPACING_MS = 2_000L
    const val TRANSIENT_FAILURE_COOLDOWN_MS = 15_000L
    private const val MAX_COOLDOWN_MS = 10 * 60_000L

    internal fun effectiveDelayMillis(retryAfterMillis: Long?): Long =
        (retryAfterMillis ?: MIN_COOLDOWN_MS)
            .coerceIn(MIN_COOLDOWN_MS, MAX_COOLDOWN_MS)

    fun recordRateLimit(
        context: Context,
        source: String,
        retryAfterMillis: Long?,
        now: Long = System.currentTimeMillis()
    ): Long {
        val delay = effectiveDelayMillis(retryAfterMillis)
        val preferences = preferences(context)
        val previous = preferences.getLong(RATE_LIMITED_UNTIL, 0L)
        val deadline = max(previous, now + delay)
        preferences.edit(commit = true) {
            putLong(RATE_LIMITED_UNTIL, deadline)
            putString(LAST_SOURCE, source.take(64))
        }
        Log.w(
            TAG,
            "Gateway cooldown recorded source=$source serverDelayMs=$retryAfterMillis " +
                "effectiveDelayMs=${deadline - now} until=$deadline"
        )
        return deadline
    }

    fun recordTransientFailure(
        context: Context,
        source: String,
        now: Long = System.currentTimeMillis()
    ): Long {
        val preferences = preferences(context)
        val previous = preferences.getLong(RATE_LIMITED_UNTIL, 0L)
        val deadline = max(previous, now + TRANSIENT_FAILURE_COOLDOWN_MS)
        preferences.edit(commit = true) {
            putLong(RATE_LIMITED_UNTIL, deadline)
            putString(LAST_SOURCE, source.take(64))
        }
        Log.w(
            TAG,
            "Gateway transient cooldown recorded source=$source " +
                "effectiveDelayMs=${deadline - now} until=$deadline"
        )
        return deadline
    }

    fun remainingMillis(
        context: Context,
        now: Long = System.currentTimeMillis()
    ): Long = max(
        0L,
        preferences(context).getLong(RATE_LIMITED_UNTIL, 0L) - now
    )

    /**
     * Atomically reserves the next Gateway HTTP request slot.
     *
     * Returns zero when the caller owns the slot, otherwise the number of
     * milliseconds it must wait. SharedPreferences makes this survive process
     * recreation; synchronization serializes the app's workers and SSE thread.
     */
    @Synchronized
    fun acquireRequestSlot(
        context: Context,
        source: String,
        now: Long = System.currentTimeMillis()
    ): Long {
        val preferences = preferences(context)
        val blockedUntil = max(
            preferences.getLong(RATE_LIMITED_UNTIL, 0L),
            preferences.getLong(NEXT_REQUEST_NOT_BEFORE, 0L)
        )
        if (blockedUntil > now) return blockedUntil - now

        preferences.edit(commit = true) {
            putLong(NEXT_REQUEST_NOT_BEFORE, now + REQUEST_SPACING_MS)
        }
        Log.i(TAG, "Gateway request slot acquired source=$source spacingMs=$REQUEST_SPACING_MS")
        return 0L
    }

    fun lastSource(context: Context): String =
        preferences(context).getString(LAST_SOURCE, "").orEmpty()

    private fun preferences(context: Context) =
        context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
}
