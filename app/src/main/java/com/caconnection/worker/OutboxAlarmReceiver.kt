package com.caconnection.worker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.caconnection.notifications.GatewayForegroundService

/**
 * AlarmManager backup that fires even under Doze / HyperOS deep sleep.
 * When JobScheduler defers WorkManager beyond the desired retry window,
 * this alarm provides a guaranteed wake-up to trigger an immediate drain.
 */
class OutboxAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        OutboxScheduler.markAlarmFired(context)
        Log.w("OutboxAlarm", "Alarm wake — forcing foreground recovery and Outbox drain")
        GatewayForegroundService.requestRecovery(context)
        OutboxScheduler.enqueueRecoveryNow(context, "alarm")
    }
}
