package com.caconnection.worker

import android.content.Context
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

object DeviceStateScheduler {
    private const val UNIQUE_WORK = "gateway_device_state"

    fun schedule(context: Context) {
        val request = PeriodicWorkRequestBuilder<DeviceStateWorker>(
            15,
            TimeUnit.MINUTES
        ).build()
        WorkManager.getInstance(context.applicationContext)
            .enqueueUniquePeriodicWork(
                UNIQUE_WORK,
                ExistingPeriodicWorkPolicy.UPDATE,
                request
            )
    }
}
