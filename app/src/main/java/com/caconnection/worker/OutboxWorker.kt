package com.caconnection.worker

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.caconnection.data.poc.PocDatabase
import com.caconnection.transport.GatewayTransportFactory
import com.caconnection.transport.Transport
import kotlinx.coroutines.CancellationException
import kotlin.math.max

class OutboxWorker(
    context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {
    companion object {
        private const val TAG = "OutboxWorker"
        private const val BATCH_SIZE = 10
        private const val IN_PROGRESS_LEASE_MS = 10 * 60 * 1_000L
    }

    internal var transportOverride: Transport? = null

    override suspend fun doWork(): Result {
        val dao = PocDatabase.get(applicationContext).pocDao()
        return try {
            val startedAt = System.currentTimeMillis()
            dao.recoverStaleInProgress(
                startedAt - IN_PROGRESS_LEASE_MS,
                startedAt
            )
            dao.recoverLegacyRetryExhaustion(startedAt)

            val processor = OutboxProcessor(
                transportOverride ?: GatewayTransportFactory.create(applicationContext)
            )
            val ready = dao.getReadyOutboxEvents(startedAt, BATCH_SIZE)
            ready.forEach { event ->
                if (dao.claimReadyOutbox(event.eventId, System.currentTimeMillis()) == 1) {
                    processor.process(event, dao::updateOutbox)
                }
            }

            scheduleRemainingWork(dao.getEarliestScheduledOutboxAt())
            Result.success()
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Exception) {
            Log.e(TAG, "Outbox drain failed", error)
            Result.retry()
        }
    }

    private fun scheduleRemainingWork(nextAttemptAt: Long?) {
        nextAttemptAt ?: return
        val delay = max(0L, nextAttemptAt - System.currentTimeMillis())
        OutboxScheduler.enqueue(applicationContext, delay)
    }
}
