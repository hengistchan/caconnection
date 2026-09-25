package com.caconnection.transport

import android.content.Context
import com.caconnection.notifications.GatewayForegroundService

enum class ConnectionHealth {
    UNKNOWN,
    CONNECTED,
    DEGRADED,
    DISCONNECTED
}

data class ConnectionSnapshot(
    val health: ConnectionHealth,
    val lastSuccessAt: Long,
    val lastFailureAt: Long,
    val firstFailureAt: Long,
    val consecutiveFailures: Int,
    val lastError: String?
)

object ConnectionHealthPolicy {
    const val DISCONNECTED_FAILURE_COUNT = 3
    const val DISCONNECTED_MIN_DURATION_MS = 5 * 60 * 1_000L

    fun evaluate(
        lastSuccessAt: Long,
        firstFailureAt: Long,
        consecutiveFailures: Int,
        now: Long
    ): ConnectionHealth = when {
        consecutiveFailures >= DISCONNECTED_FAILURE_COUNT &&
            firstFailureAt > 0L &&
            now - firstFailureAt >= DISCONNECTED_MIN_DURATION_MS ->
            ConnectionHealth.DISCONNECTED
        consecutiveFailures > 0 -> ConnectionHealth.DEGRADED
        lastSuccessAt > 0 -> ConnectionHealth.CONNECTED
        else -> ConnectionHealth.UNKNOWN
    }
}

object ConnectionStateStore {
    private const val PREFERENCES = "gateway_connection_state"
    private const val KEY_LAST_SUCCESS = "last_success_at"
    private const val KEY_LAST_FAILURE = "last_failure_at"
    private const val KEY_FIRST_FAILURE = "first_failure_at"
    private const val KEY_FAILURE_COUNT = "consecutive_failures"
    private const val KEY_LAST_ERROR = "last_error"

    fun record(context: Context, result: TransportResult, now: Long = System.currentTimeMillis()) {
        val applicationContext = context.applicationContext
        val preferences = applicationContext.getSharedPreferences(
            PREFERENCES,
            Context.MODE_PRIVATE
        )
        val previous = snapshot(applicationContext).health
        when (result) {
            TransportResult.Success -> preferences.edit()
                .putLong(KEY_LAST_SUCCESS, now)
                .putInt(KEY_FAILURE_COUNT, 0)
                .remove(KEY_FIRST_FAILURE)
                .remove(KEY_LAST_ERROR)
                .apply()

            is TransportResult.RetryableFailure -> {
                val previousFailures = preferences.getInt(KEY_FAILURE_COUNT, 0)
                preferences.edit()
                    .putLong(KEY_LAST_FAILURE, now)
                    .putLong(
                        KEY_FIRST_FAILURE,
                        if (previousFailures == 0) now
                        else preferences.getLong(KEY_FIRST_FAILURE, now)
                    )
                    .putInt(
                        KEY_FAILURE_COUNT,
                        previousFailures.coerceAtMost(Int.MAX_VALUE - 1) + 1
                    )
                    .putString(KEY_LAST_ERROR, sanitize(result.error))
                    .apply()
            }

            is TransportResult.PermanentFailure -> {
                val previousFailures = preferences.getInt(KEY_FAILURE_COUNT, 0)
                preferences.edit()
                    .putLong(KEY_LAST_FAILURE, now)
                    .putLong(
                        KEY_FIRST_FAILURE,
                        if (previousFailures == 0) now
                        else preferences.getLong(KEY_FIRST_FAILURE, now)
                    )
                    .putInt(
                        KEY_FAILURE_COUNT,
                        previousFailures
                            .coerceAtLeast(ConnectionHealthPolicy.DISCONNECTED_FAILURE_COUNT)
                    )
                    .putString(KEY_LAST_ERROR, sanitize(result.error))
                    .apply()
            }
        }
        val current = snapshot(applicationContext).health
        if (current != previous || current == ConnectionHealth.DISCONNECTED) {
            GatewayForegroundService.refresh(applicationContext)
        }
    }

    fun snapshot(context: Context): ConnectionSnapshot {
        val preferences = context.applicationContext.getSharedPreferences(
            PREFERENCES,
            Context.MODE_PRIVATE
        )
        val lastSuccessAt = preferences.getLong(KEY_LAST_SUCCESS, 0L)
        val firstFailureAt = preferences.getLong(KEY_FIRST_FAILURE, 0L)
        val failures = preferences.getInt(KEY_FAILURE_COUNT, 0)
        return ConnectionSnapshot(
            health = ConnectionHealthPolicy.evaluate(
                lastSuccessAt,
                firstFailureAt,
                failures,
                System.currentTimeMillis()
            ),
            lastSuccessAt = lastSuccessAt,
            lastFailureAt = preferences.getLong(KEY_LAST_FAILURE, 0L),
            firstFailureAt = firstFailureAt,
            consecutiveFailures = failures,
            lastError = preferences.getString(KEY_LAST_ERROR, null)
        )
    }

    private fun sanitize(error: String): String =
        error.replace(Regex("https?://\\S+"), "[URL]").take(128)
}
