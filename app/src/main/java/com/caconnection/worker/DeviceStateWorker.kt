package com.caconnection.worker

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.caconnection.transport.DeviceStateReporter

class DeviceStateWorker(
    context: Context,
    params: WorkerParameters
) : Worker(context, params) {
    override fun doWork(): Result {
        DeviceStateReporter.enqueue(applicationContext)
        return Result.success()
    }
}
