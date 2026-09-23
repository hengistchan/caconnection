package com.caconnection.worker

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit
import kotlin.math.max

object RemoteCommandScheduler {
    private const val TAG = "RemoteCommandScheduler"
    private const val UNIQUE_WORK = "remote_sms_command_poll"
    const val NORMAL_POLL_DELAY_MS = 15_000L
    const val UNCONFIGURED_POLL_DELAY_MS = 15 * 60_000L

    fun enqueueNow(context: Context) = enqueue(context, 0L)

    fun enqueue(context: Context, delayMillis: Long) {
        val request = OneTimeWorkRequestBuilder<RemoteCommandWorker>()
            .setInitialDelay(max(0L, delayMillis), TimeUnit.MILLISECONDS)
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build()
            )
            .setBackoffCriteria(
                BackoffPolicy.EXPONENTIAL,
                5,
                TimeUnit.SECONDS
            )
            .build()
        runCatching {
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniqueWork(
                    UNIQUE_WORK,
                    ExistingWorkPolicy.APPEND_OR_REPLACE,
                    request
                )
        }.onFailure {
            Log.e(TAG, "Unable to schedule remote command polling", it)
        }
    }
}
