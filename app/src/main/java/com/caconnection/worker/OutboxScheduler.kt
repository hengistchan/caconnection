package com.caconnection.worker

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit
import kotlin.math.max

object OutboxScheduler {
    private const val TAG = "OutboxScheduler"
    const val WORK_TAG = "outbox_processing"

    fun enqueueNow(context: Context) = enqueue(context, 0L)

    fun enqueue(context: Context, delayMillis: Long) {
        val request = OneTimeWorkRequestBuilder<OutboxWorker>()
            .addTag(WORK_TAG)
            .setInitialDelay(max(0L, delayMillis), TimeUnit.MILLISECONDS)
            .setBackoffCriteria(
                BackoffPolicy.EXPONENTIAL,
                10,
                TimeUnit.SECONDS
            )
            .build()

        runCatching {
            WorkManager.getInstance(context.applicationContext)
                .enqueue(request)
        }.onFailure {
            // The durable row remains pending. Application startup schedules
            // another drain attempt if WorkManager was temporarily unavailable.
            Log.e(TAG, "Unable to enqueue outbox processing", it)
        }
    }
}
