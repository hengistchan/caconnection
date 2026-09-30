package com.caconnection.transport

import android.content.Context
import androidx.core.content.edit

data class GatewayHealthSnapshot(
    val processStartedAt: Long,
    val foregroundServiceStartedAt: Long,
    val lastWatchdogTickAt: Long,
    val lastWatchdogRecoveryAt: Long,
    val lastNetworkAvailableAt: Long,
    val lastStreamConnectedAt: Long,
    val lastStreamHeartbeatAt: Long,
    val lastStreamDisconnectedAt: Long,
    val lastNotificationListenerConnectedAt: Long,
    val lastNotificationListenerDisconnectedAt: Long,
    val lastNotificationObservedAt: Long,
    val lastNotificationRebindRequestedAt: Long,
    val notificationRebindAttempts: Int,
    val notificationRebindPendingUntil: Long,
    val lastNotificationRebindReason: String,
    val lastOutboxDrainStartedAt: Long,
    val lastOutboxDrainSucceededAt: Long,
    val lastOutboxDrainFailedAt: Long
)

/**
 * Process-independent health timestamps used by the foreground watchdog and
 * recovery entry points. No message content, addresses, URLs, or credentials
 * are stored here.
 */
object GatewayHealthStore {
    private const val PREFERENCES = "gateway_health"

    private const val PROCESS_STARTED = "process_started_at"
    private const val FOREGROUND_STARTED = "foreground_service_started_at"
    private const val WATCHDOG_TICK = "last_watchdog_tick_at"
    private const val WATCHDOG_RECOVERY = "last_watchdog_recovery_at"
    private const val NETWORK_AVAILABLE = "last_network_available_at"
    private const val STREAM_CONNECTED = "last_stream_connected_at"
    private const val STREAM_HEARTBEAT = "last_stream_heartbeat_at"
    private const val STREAM_DISCONNECTED = "last_stream_disconnected_at"
    private const val LISTENER_CONNECTED = "last_notification_listener_connected_at"
    private const val LISTENER_DISCONNECTED = "last_notification_listener_disconnected_at"
    private const val NOTIFICATION_OBSERVED = "last_notification_observed_at"
    private const val LISTENER_REBIND = "last_notification_rebind_requested_at"
    private const val LISTENER_REBIND_ATTEMPTS = "notification_rebind_attempts"
    private const val LISTENER_REBIND_PENDING_UNTIL = "notification_rebind_pending_until"
    private const val LISTENER_REBIND_REASON = "last_notification_rebind_reason"
    private const val OUTBOX_STARTED = "last_outbox_drain_started_at"
    private const val OUTBOX_SUCCEEDED = "last_outbox_drain_succeeded_at"
    private const val OUTBOX_FAILED = "last_outbox_drain_failed_at"

    fun markProcessStarted(context: Context, now: Long = System.currentTimeMillis()) =
        put(context, PROCESS_STARTED, now)

    fun markForegroundServiceStarted(context: Context, now: Long = System.currentTimeMillis()) =
        put(context, FOREGROUND_STARTED, now)

    fun markWatchdogTick(context: Context, now: Long = System.currentTimeMillis()) =
        put(context, WATCHDOG_TICK, now)

    fun markWatchdogRecovery(context: Context, now: Long = System.currentTimeMillis()) =
        put(context, WATCHDOG_RECOVERY, now)

    fun markNetworkAvailable(context: Context, now: Long = System.currentTimeMillis()) =
        put(context, NETWORK_AVAILABLE, now)

    fun markStreamConnected(context: Context, now: Long = System.currentTimeMillis()) =
        put(context, STREAM_CONNECTED, now)

    fun markStreamHeartbeat(context: Context, now: Long = System.currentTimeMillis()) =
        put(context, STREAM_HEARTBEAT, now)

    fun markStreamDisconnected(context: Context, now: Long = System.currentTimeMillis()) =
        put(context, STREAM_DISCONNECTED, now)

    fun markNotificationListenerConnected(
        context: Context,
        now: Long = System.currentTimeMillis()
    ) {
        // A successful bind ends the rebind escalation chain.
        preferences(context).edit {
            putLong(LISTENER_CONNECTED, now)
            putInt(LISTENER_REBIND_ATTEMPTS, 0)
            putLong(LISTENER_REBIND_PENDING_UNTIL, 0L)
            putString(LISTENER_REBIND_REASON, "")
        }
    }

    fun markNotificationListenerDisconnected(
        context: Context,
        now: Long = System.currentTimeMillis()
    ) = put(context, LISTENER_DISCONNECTED, now)

    fun markNotificationObserved(context: Context, now: Long = System.currentTimeMillis()) =
        put(context, NOTIFICATION_OBSERVED, now)

    fun markNotificationRebindRequested(
        context: Context,
        reason: String,
        pendingUntil: Long,
        now: Long = System.currentTimeMillis()
    ) {
        val preferences = preferences(context)
        val attempts = (preferences.getInt(LISTENER_REBIND_ATTEMPTS, 0) + 1)
            .coerceAtMost(4)
        preferences.edit {
            putLong(LISTENER_REBIND, now)
            putInt(LISTENER_REBIND_ATTEMPTS, attempts)
            putLong(LISTENER_REBIND_PENDING_UNTIL, pendingUntil)
            putString(LISTENER_REBIND_REASON, reason.take(64))
        }
    }

    fun markOutboxDrainStarted(context: Context, now: Long = System.currentTimeMillis()) =
        put(context, OUTBOX_STARTED, now)

    fun markOutboxDrainSucceeded(context: Context, now: Long = System.currentTimeMillis()) =
        put(context, OUTBOX_SUCCEEDED, now)

    fun markOutboxDrainFailed(context: Context, now: Long = System.currentTimeMillis()) =
        put(context, OUTBOX_FAILED, now)

    fun snapshot(context: Context): GatewayHealthSnapshot {
        val preferences = preferences(context)
        return GatewayHealthSnapshot(
            processStartedAt = preferences.getLong(PROCESS_STARTED, 0L),
            foregroundServiceStartedAt = preferences.getLong(FOREGROUND_STARTED, 0L),
            lastWatchdogTickAt = preferences.getLong(WATCHDOG_TICK, 0L),
            lastWatchdogRecoveryAt = preferences.getLong(WATCHDOG_RECOVERY, 0L),
            lastNetworkAvailableAt = preferences.getLong(NETWORK_AVAILABLE, 0L),
            lastStreamConnectedAt = preferences.getLong(STREAM_CONNECTED, 0L),
            lastStreamHeartbeatAt = preferences.getLong(STREAM_HEARTBEAT, 0L),
            lastStreamDisconnectedAt = preferences.getLong(STREAM_DISCONNECTED, 0L),
            lastNotificationListenerConnectedAt = preferences.getLong(LISTENER_CONNECTED, 0L),
            lastNotificationListenerDisconnectedAt =
                preferences.getLong(LISTENER_DISCONNECTED, 0L),
            lastNotificationObservedAt = preferences.getLong(NOTIFICATION_OBSERVED, 0L),
            lastNotificationRebindRequestedAt = preferences.getLong(LISTENER_REBIND, 0L),
            notificationRebindAttempts = preferences.getInt(LISTENER_REBIND_ATTEMPTS, 0),
            notificationRebindPendingUntil =
                preferences.getLong(LISTENER_REBIND_PENDING_UNTIL, 0L),
            lastNotificationRebindReason =
                preferences.getString(LISTENER_REBIND_REASON, "").orEmpty(),
            lastOutboxDrainStartedAt = preferences.getLong(OUTBOX_STARTED, 0L),
            lastOutboxDrainSucceededAt = preferences.getLong(OUTBOX_SUCCEEDED, 0L),
            lastOutboxDrainFailedAt = preferences.getLong(OUTBOX_FAILED, 0L)
        )
    }

    private fun put(context: Context, key: String, value: Long) {
        preferences(context).edit { putLong(key, value) }
    }

    private fun preferences(context: Context) =
        context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
}
