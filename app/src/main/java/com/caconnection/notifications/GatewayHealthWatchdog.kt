package com.caconnection.notifications

import android.content.Context
import android.util.Log
import com.caconnection.data.poc.PocDatabase
import com.caconnection.transport.CommandStreamClient
import com.caconnection.transport.CommandStreamState
import com.caconnection.transport.GatewayHealthStore
import com.caconnection.transport.GatewayTransportConfig
import com.caconnection.worker.GatewayWatchdogPolicy
import com.caconnection.worker.GatewayWatchdogScheduler
import com.caconnection.worker.OutboxScheduler
import com.caconnection.worker.RemoteCommandScheduler
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Low-frequency in-process health check. It repairs stalled availability
 * components without restarting the application or touching durable data.
 */
class GatewayHealthWatchdog(
    private val context: Context
) {
    companion object {
        private const val TAG = "GatewayWatchdog"
        private const val INITIAL_DELAY_SECONDS = 30L
        private const val INTERVAL_SECONDS = 60L
        private const val STREAM_HEARTBEAT_STALE_MS = 2 * 60_000L
        private const val RECOVERY_THROTTLE_MS = 2 * 60_000L
    }

    private var executor: ScheduledExecutorService? = null

    fun start() {
        if (executor != null) return
        Log.i(TAG, "Starting foreground health watchdog interval=${INTERVAL_SECONDS}s")
        executor = Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "gateway-health-watchdog").apply { isDaemon = true }
        }.also {
            it.scheduleWithFixedDelay(
                ::runCheckSafely,
                INITIAL_DELAY_SECONDS,
                INTERVAL_SECONDS,
                TimeUnit.SECONDS
            )
        }
    }

    fun stop() {
        executor?.shutdownNow()
        executor = null
        Log.i(TAG, "Stopped foreground health watchdog")
    }

    private fun runCheckSafely() {
        runCatching { runCheck() }
            .onFailure { Log.e(TAG, "Health watchdog check failed", it) }
    }

    private fun runCheck() {
        val now = System.currentTimeMillis()
        GatewayHealthStore.markWatchdogTick(context, now)
        val health = GatewayHealthStore.snapshot(context)
        val dao = PocDatabase.get(context).pocDao()
        val oldestPendingAt = dao.getOldestActiveOutboxCreatedAt()
        val pendingCount = dao.countActiveOutboxEvents()
        val outboxLevel = GatewayWatchdogPolicy.outboxLevel(now, oldestPendingAt)
        val pendingAge = oldestPendingAt?.let { now - it } ?: 0L
        if (outboxLevel != GatewayWatchdogPolicy.OutboxLevel.CRITICAL) {
            NotificationHelper.cancelOutboxBacklogAlert(context)
        }
        val heartbeatAge = CommandStreamState.lastHeartbeatAt
            .takeIf { it > 0L }
            ?.let { now - it }

        val transport = GatewayTransportConfig.load(context)
        val streamExpected = transport.enabled && transport.configured
        val streamThreadMissing = streamExpected && !CommandStreamClient.isRunning
        val disconnectedTooLong = streamExpected &&
            !CommandStreamState.connected &&
            health.lastStreamDisconnectedAt > 0L &&
            now - health.lastStreamDisconnectedAt >= STREAM_HEARTBEAT_STALE_MS
        val staleHeartbeat = streamExpected &&
            CommandStreamState.connected &&
            (heartbeatAge == null || heartbeatAge >= STREAM_HEARTBEAT_STALE_MS)
        val staleStream = streamThreadMissing || disconnectedTooLong || staleHeartbeat
        val staleOutbox = outboxLevel != GatewayWatchdogPolicy.OutboxLevel.OK
        val listenerDisconnected =
            health.lastNotificationListenerDisconnectedAt >
                health.lastNotificationListenerConnectedAt

        if (!staleStream && !staleOutbox && !listenerDisconnected) {
            Log.d(
                TAG,
                "Health check healthy streamExpected=$streamExpected " +
                    "stream=${CommandStreamState.connected} " +
                    "thread=${CommandStreamClient.isRunning} " +
                    "heartbeatAgeMs=${heartbeatAge ?: -1L} pending=$pendingCount"
            )
            return
        }

        // WARNING is recoverable and stays quiet; only CRITICAL gets loud so a
        // brief backlog never spams the user.
        if (outboxLevel == GatewayWatchdogPolicy.OutboxLevel.CRITICAL) {
            Log.e(
                TAG,
                "Outbox backlog critical pending=$pendingCount pendingAgeMs=$pendingAge"
            )
            NotificationHelper.notifyOutboxBacklogAlert(
                context,
                GatewayForegroundService.recoveryPendingIntent(context),
                GatewayForegroundService.openDiagnosticsPendingIntent(context),
                pendingCount = pendingCount,
                oldestAgeMinutes = pendingAge / 60_000L
            )
            // Tightened external check while the backlog is unresolved.
            GatewayWatchdogScheduler.schedule(
                context,
                GatewayWatchdogScheduler.BACKLOG_INTERVAL_MS
            )
        }

        if (now - health.lastWatchdogRecoveryAt < RECOVERY_THROTTLE_MS) {
            Log.w(
                TAG,
                "Recovery throttled staleStream=$staleStream staleOutbox=$staleOutbox " +
                    "listenerDisconnected=$listenerDisconnected pending=$pendingCount"
            )
            return
        }

        GatewayHealthStore.markWatchdogRecovery(context, now)
        Log.w(
            TAG,
            "Recovering unhealthy gateway staleStream=$staleStream " +
                "streamExpected=$streamExpected " +
                "streamThreadMissing=$streamThreadMissing " +
                "disconnectedTooLong=$disconnectedTooLong " +
                "heartbeatAgeMs=${heartbeatAge ?: -1L} staleOutbox=$staleOutbox " +
                "outboxLevel=$outboxLevel pending=$pendingCount pendingAgeMs=$pendingAge " +
                "listenerDisconnected=$listenerDisconnected"
        )
        if (staleStream) CommandStreamClient.forceReconnect("heartbeat_stale")
        if (staleOutbox) {
            OutboxScheduler.enqueueRecoveryNow(context, "foreground_watchdog")
            RemoteCommandScheduler.enqueueNow(context)
        }
        if (listenerDisconnected) {
            NotificationAccess.requestRebindIfEnabled(context, "watchdog")
        }
    }
}
