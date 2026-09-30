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
    private const val KEY_NEXT_WAKE_AT = "next_wake_at"
    private const val KEY_LAST_SCHEDULED_AT = "last_scheduled_at"
    private const val KEY_LAST_SCHEDULE_SOURCE = "last_schedule_source"
    private const val KEY_LAST_ALARM_FIRED_AT = "last_alarm_fired_at"
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
            reconcileScheduledWake(applicationContext, "startup")
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
                    reconcileScheduledWake(applicationContext, "migration")
                },
                { command -> command.run() }
            )
        }.onFailure {
            Log.e(TAG, "Unable to reconcile legacy outbox work", it)
            reconcileScheduledWake(applicationContext, "migration_failure")
        }
    }

    fun enqueueNow(context: Context, source: String = "event") {
        recordSchedule(context, 0L, source)
        enqueueUnique(
            context = context,
            uniqueName = DRAIN_WORK_NAME,
            delayMillis = 0L,
            replace = false,
            retryWake = false
        )
    }

    fun enqueueRecoveryNow(context: Context, source: String) {
        recordSchedule(context, 0L, source)
        enqueueUnique(
            context = context,
            // Recovery and event-driven drains must share one uniqueness
            // boundary. Room row claims prevent duplicate delivery, but two
            // workers still race over leases, rate-limit slots and retry state.
            uniqueName = DRAIN_WORK_NAME,
            delayMillis = 0L,
            replace = false,
            retryWake = false
        )
    }

    fun scheduleRetryWake(
        context: Context,
        delayMillis: Long,
        source: String = "retry"
    ) {
        recordSchedule(context, delayMillis, source)
        enqueueUnique(
            context = context,
            uniqueName = RETRY_WAKE_WORK_NAME,
            delayMillis = delayMillis,
            replace = true,
            retryWake = true
        )
    }

    fun reconcileScheduledWake(context: Context, source: String) {
        val state = snapshot(context)
        val now = System.currentTimeMillis()
        if (state.nextWakeAt <= 0L || state.nextWakeAt <= now) {
            Log.w(
                TAG,
                "Outbox wake missing/overdue source=$source nextWakeAt=${state.nextWakeAt} " +
                    "overdueMs=${if (state.nextWakeAt > 0L) now - state.nextWakeAt else -1L}"
            )
            enqueueRecoveryNow(context, "${source}_overdue")
        } else {
            val delay = state.nextWakeAt - now
            Log.i(TAG, "Restoring outbox wake source=$source delayMs=$delay")
            scheduleRetryWake(context, delay, "${source}_restore")
        }
    }

    fun markAlarmFired(context: Context, now: Long = System.currentTimeMillis()) {
        preferences(context).edit(commit = true) {
            putLong(KEY_LAST_ALARM_FIRED_AT, now)
            remove(KEY_NEXT_WAKE_AT)
        }
    }

    /** A WorkManager retry wake has been consumed and no longer needs restoring. */
    fun markRetryWakeConsumed(context: Context) {
        preferences(context).edit(commit = true) {
            remove(KEY_NEXT_WAKE_AT)
        }
        cancelAlarmWake(context)
    }

    /** No retryable rows remain, so discard every stale delayed-wake marker. */
    fun clearScheduledWake(context: Context) {
        preferences(context).edit(commit = true) {
            remove(KEY_NEXT_WAKE_AT)
        }
        runCatching {
            WorkManager.getInstance(context.applicationContext)
                .cancelUniqueWork(RETRY_WAKE_WORK_NAME)
        }.onFailure {
            Log.w(TAG, "Unable to cancel stale retry work", it)
        }
        cancelAlarmWake(context)
    }

    fun snapshot(context: Context): OutboxScheduleSnapshot {
        val preferences = preferences(context)
        return OutboxScheduleSnapshot(
            nextWakeAt = preferences.getLong(KEY_NEXT_WAKE_AT, 0L),
            lastScheduledAt = preferences.getLong(KEY_LAST_SCHEDULED_AT, 0L),
            lastScheduleSource = preferences.getString(KEY_LAST_SCHEDULE_SOURCE, "").orEmpty(),
            lastAlarmFiredAt = preferences.getLong(KEY_LAST_ALARM_FIRED_AT, 0L)
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
        val requestBuilder = OneTimeWorkRequestBuilder<OutboxWorker>()
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
        // WorkManager rejects expedited requests with an initial delay.
        // Immediate drains should bypass standby throttling when quota allows;
        // delayed retry wakes retain their delay and use the Alarm backup.
        if (delayMillis <= 0L) {
            requestBuilder.setExpedited(
                OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST
            )
        }
        val request = requestBuilder.build()

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

    private fun cancelAlarmWake(context: Context) {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE)
            as? AlarmManager ?: return
        val pending = PendingIntent.getBroadcast(
            context,
            0,
            Intent(context, OutboxAlarmReceiver::class.java),
            PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
        ) ?: return
        runCatching {
            alarmManager.cancel(pending)
            pending.cancel()
        }.onFailure {
            Log.w(TAG, "Unable to cancel stale alarm wake", it)
        }
    }

    private fun recordSchedule(context: Context, delayMillis: Long, source: String) {
        val now = System.currentTimeMillis()
        preferences(context).edit(commit = true) {
            // An immediate drain must not erase a still-valid delayed retry.
            // The delayed wake is cleared only when consumed or when the DAO
            // confirms that no retryable rows remain.
            if (delayMillis > 0L) putLong(KEY_NEXT_WAKE_AT, now + delayMillis)
            putLong(KEY_LAST_SCHEDULED_AT, now)
            putString(KEY_LAST_SCHEDULE_SOURCE, source.take(64))
        }
        Log.i(
            TAG,
            "Outbox scheduled source=$source delayMs=${delayMillis.coerceAtLeast(0L)}"
        )
    }

    private fun preferences(context: Context) =
        context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
}

data class OutboxScheduleSnapshot(
    val nextWakeAt: Long,
    val lastScheduledAt: Long,
    val lastScheduleSource: String,
    val lastAlarmFiredAt: Long
)
