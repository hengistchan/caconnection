package com.caconnection.worker

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.content.edit
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit
import kotlin.math.max

object OutboxScheduler {
    private const val TAG = "OutboxScheduler"
    private const val PREFERENCES = "outbox_scheduler"
    private const val KEY_MIGRATION_VERSION = "migration_version"
    private const val CURRENT_MIGRATION_VERSION = 1
    private const val DRAIN_WORK_NAME = "outbox_drain"
    private const val RETRY_WAKE_WORK_NAME = "outbox_retry_wake"
    const val WORK_TAG = "outbox_processing"

    fun reconcileLegacyWork(context: Context) {
        val applicationContext = context.applicationContext
        val preferences = applicationContext.getSharedPreferences(
            PREFERENCES,
            Context.MODE_PRIVATE
        )
        if (preferences.getInt(KEY_MIGRATION_VERSION, 0) >= CURRENT_MIGRATION_VERSION) {
            enqueueNow(applicationContext)
            return
        }

        runCatching {
            val workManager = WorkManager.getInstance(applicationContext)
            val cancellation = workManager.cancelAllWorkByTag(WORK_TAG).result
            cancellation.addListener(
                {
                    runCatching {
                        cancellation.get()
                        preferences.edit(commit = true) {
                            putInt(KEY_MIGRATION_VERSION, CURRENT_MIGRATION_VERSION)
                        }
                    }.onFailure {
                        Log.e(TAG, "Unable to complete legacy outbox migration", it)
                    }
                    enqueueNow(applicationContext)
                },
                { command -> command.run() }
            )
        }.onFailure {
            Log.e(TAG, "Unable to reconcile legacy outbox work", it)
            enqueueNow(applicationContext)
        }
    }

    fun enqueueNow(context: Context) {
        enqueueUnique(
            context = context,
            uniqueName = DRAIN_WORK_NAME,
            delayMillis = 0L,
            replace = false,
            retryWake = false
        )
    }

    fun scheduleRetryWake(context: Context, delayMillis: Long) {
        enqueueUnique(
            context = context,
            uniqueName = RETRY_WAKE_WORK_NAME,
            delayMillis = delayMillis,
            replace = true,
            retryWake = true
        )
    }

    private fun enqueueUnique(
        context: Context,
        uniqueName: String,
        delayMillis: Long,
        replace: Boolean,
        retryWake: Boolean
    ) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        val request = OneTimeWorkRequestBuilder<OutboxWorker>()
            .addTag(WORK_TAG)
            .setInputData(
                androidx.work.workDataOf(
                    OutboxWorker.KEY_RETRY_WAKE to retryWake
                )
            )
            .setConstraints(constraints)
            .setInitialDelay(max(0L, delayMillis), TimeUnit.MILLISECONDS)
            .setBackoffCriteria(
                BackoffPolicy.EXPONENTIAL,
                10,
                TimeUnit.SECONDS
            )
            // Expedited work bypasses App Standby bucket throttling and
            // Doze scheduling deferrals — critical on HyperOS.
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .build()

        runCatching {
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniqueWork(
                    uniqueName,
                    if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP,
                    request
                )
        }.onFailure {
            // The durable row remains pending. Application startup schedules
            // another drain attempt if WorkManager was temporarily unavailable.
            Log.e(TAG, "Unable to enqueue unique outbox work name=$uniqueName", it)
        }

        // AlarmManager backup: fires even when JobScheduler is deferred by
        // Doze or HyperOS power management.
        if (delayMillis > 0L) {
            scheduleAlarmWake(context, delayMillis)
        }
    }

    private fun scheduleAlarmWake(context: Context, delayMillis: Long) {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE)
            as? AlarmManager ?: return
        val intent = Intent(context, OutboxAlarmReceiver::class.java)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val pending = PendingIntent.getBroadcast(context, 0, intent, flags)
        val triggerAt = System.currentTimeMillis() + delayMillis

        runCatching {
            if (alarmManager.canScheduleExactAlarms()) {
                alarmManager.setExactAndAllowWhileIdle(
                    AlarmManager.RTC_WAKEUP,
                    triggerAt,
                    pending
                )
            } else {
                alarmManager.setAndAllowWhileIdle(
                    AlarmManager.RTC_WAKEUP,
                    triggerAt,
                    pending
                )
            }
        }.onFailure {
            Log.w(TAG, "Unable to schedule alarm wake", it)
        }
    }
}
