package com.caconnection.worker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * AlarmManager backup that fires even under Doze / HyperOS deep sleep.
 * When JobScheduler defers WorkManager beyond the desired retry window,
 * this alarm provides a guaranteed wake-up to trigger an immediate drain.
 */
class OutboxAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        Log.i("OutboxAlarm", "Alarm wake — triggering Outbox drain")
        OutboxScheduler.enqueueNow(context)
    }
}
