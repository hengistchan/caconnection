package com.caconnection.worker

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.util.Log
import kotlin.random.Random

object GatewayWatchdogScheduler {
    private const val TAG = "GatewayWatchdogAlarm"

    /** Normal cadence when nothing is backed up. */
    const val NORMAL_INTERVAL_MS = 15 * 60_000L

    /**
     * Tightened cadence while the outbox backlog is unresolved. The next
     * check re-arms the normal cadence once the queue is healthy again.
     */
    const val BACKLOG_INTERVAL_MS = 5 * 60_000L

    fun schedule(context: Context, intervalMs: Long = NORMAL_INTERVAL_MS) {
        val applicationContext = context.applicationContext
        val alarmManager = applicationContext.getSystemService(Context.ALARM_SERVICE)
            as? AlarmManager ?: return
        val pendingIntent = PendingIntent.getBroadcast(
            applicationContext,
            0,
            Intent(applicationContext, GatewayWatchdogReceiver::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val delayMs = GatewayWatchdogPolicy.withJitter(intervalMs, Random.Default)
        val triggerAt = SystemClock.elapsedRealtime() + delayMs
        runCatching {
            // This watchdog is intentionally inexact and low-frequency. Its
            // job is eventual recovery, not user-visible exact timing.
            alarmManager.setAndAllowWhileIdle(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                triggerAt,
                pendingIntent
            )
            Log.i(TAG, "Scheduled gateway watchdog alarm delayMs=$delayMs baseMs=$intervalMs")
        }.onFailure {
            Log.e(TAG, "Unable to schedule gateway watchdog alarm", it)
        }
    }
}

internal object GatewayWatchdogPolicy {
    const val WATCHDOG_TICK_STALE_MS = 5 * 60_000L
    const val OUTBOX_WARNING_MS = 2 * 60_000L
    const val OUTBOX_CRITICAL_MS = 10 * 60_000L

    enum class OutboxLevel { OK, WARNING, CRITICAL }

    fun outboxLevel(now: Long, oldestPendingAt: Long?): OutboxLevel {
        if (oldestPendingAt == null || oldestPendingAt <= 0L) return OutboxLevel.OK
        val age = now - oldestPendingAt
        return when {
            age >= OUTBOX_CRITICAL_MS -> OutboxLevel.CRITICAL
            age >= OUTBOX_WARNING_MS -> OutboxLevel.WARNING
            else -> OutboxLevel.OK
        }
    }

    fun shouldRecover(
        now: Long,
        lastWatchdogTickAt: Long,
        oldestPendingAt: Long?
    ): Boolean {
        val missingOrStaleTick = lastWatchdogTickAt <= 0L ||
            now - lastWatchdogTickAt >= WATCHDOG_TICK_STALE_MS
        val backlog = outboxLevel(now, oldestPendingAt) != OutboxLevel.OK
        return missingOrStaleTick || backlog
    }

    /**
     * Spreads alarm wakeups across devices so a fleet does not reconnect in
     * lockstep. The band is a fifth of the base interval, always including 0.
     */
    fun withJitter(delayMs: Long, random: Random): Long =
        delayMs + random.nextLong(0L, delayMs / 5L + 1L)
}
