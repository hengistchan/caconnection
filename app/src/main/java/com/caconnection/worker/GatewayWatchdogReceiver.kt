package com.caconnection.worker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.caconnection.data.poc.PocDatabase
import com.caconnection.notifications.GatewayForegroundService
import com.caconnection.notifications.NotificationAccess
import com.caconnection.notifications.NotificationHelper
import com.caconnection.transport.CommandStreamClient
import com.caconnection.transport.GatewayHealthStore
import java.util.concurrent.Executors

/**
 * Low-frequency process-external recovery entry point. It always reschedules
 * itself first, then performs a small database health query off the broadcast
 * main thread. The durable queues remain the correctness path.
 */
class GatewayWatchdogReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val applicationContext = context.applicationContext
        GatewayWatchdogScheduler.schedule(applicationContext)
        val pendingResult = goAsync()
        EXECUTOR.execute {
            try {
                val now = System.currentTimeMillis()
                val health = GatewayHealthStore.snapshot(applicationContext)
                val dao = PocDatabase.get(applicationContext).pocDao()
                val oldestPendingAt = dao.getOldestActiveOutboxCreatedAt()
                val pendingCount = dao.countActiveOutboxEvents()
                val outboxLevel = GatewayWatchdogPolicy.outboxLevel(now, oldestPendingAt)
                val shouldRecover = GatewayWatchdogPolicy.shouldRecover(
                    now = now,
                    lastWatchdogTickAt = health.lastWatchdogTickAt,
                    oldestPendingAt = oldestPendingAt
                )
                Log.i(
                    TAG,
                    "Alarm check recover=$shouldRecover outboxLevel=$outboxLevel " +
                        "watchdogAgeMs=${age(now, health.lastWatchdogTickAt)} " +
                        "pending=$pendingCount pendingAgeMs=${age(now, oldestPendingAt ?: 0L)}"
                )
                if (outboxLevel == GatewayWatchdogPolicy.OutboxLevel.CRITICAL) {
                    // The backlog outlived one full normal alarm cycle — get
                    // loud and re-check on the tightened cadence.
                    NotificationHelper.notifyOutboxBacklogAlert(
                        applicationContext,
                        GatewayForegroundService.recoveryPendingIntent(applicationContext),
                        GatewayForegroundService.openDiagnosticsPendingIntent(applicationContext),
                        pendingCount = pendingCount,
                        oldestAgeMinutes =
                            age(now, oldestPendingAt ?: 0L) / 60_000L
                    )
                    GatewayWatchdogScheduler.schedule(
                        applicationContext,
                        GatewayWatchdogScheduler.BACKLOG_INTERVAL_MS
                    )
                } else {
                    NotificationHelper.cancelOutboxBacklogAlert(applicationContext)
                }
                if (shouldRecover) {
                    GatewayHealthStore.markWatchdogRecovery(applicationContext, now)
                    GatewayForegroundService.requestRecovery(applicationContext)
                    if (pendingCount > 0) {
                        OutboxScheduler.enqueueRecoveryNow(
                            applicationContext,
                            "external_watchdog"
                        )
                    }
                    CommandStreamClient.forceReconnect("watchdog_alarm")
                    NotificationAccess.requestRebindIfEnabled(
                        applicationContext,
                        "watchdog_alarm"
                    )
                }
            } catch (error: Exception) {
                Log.e(TAG, "Gateway watchdog alarm check failed", error)
            } finally {
                pendingResult.finish()
            }
        }
    }

    private fun age(now: Long, timestamp: Long): Long =
        if (timestamp <= 0L) -1L else (now - timestamp).coerceAtLeast(0L)

    companion object {
        private const val TAG = "GatewayWatchdogAlarm"
        private val EXECUTOR = Executors.newSingleThreadExecutor()
    }
}
