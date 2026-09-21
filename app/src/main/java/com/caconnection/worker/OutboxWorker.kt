package com.caconnection.worker

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.caconnection.data.poc.PocEventChangeNotifier
import com.caconnection.data.poc.PocDatabase
import com.caconnection.data.poc.OutboxStatus
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
        private const val MAX_EVENTS_PER_RUN = 100
        private const val IN_PROGRESS_LEASE_MS = 10 * 60 * 1_000L
        const val KEY_RETRY_WAKE = "retry_wake"
    }

    internal var transportOverride: Transport? = null

    override suspend fun doWork(): Result {
        if (inputData.getBoolean(KEY_RETRY_WAKE, false)) {
            OutboxScheduler.enqueueNow(applicationContext)
            return Result.success()
        }

        val dao = PocDatabase.get(applicationContext).pocDao()
        var recoveredStale = 0
        var recoveredLegacy = 0
        var processed = 0
        var succeeded = 0
        var retrying = 0
        var failed = 0
        return try {
            val startedAt = System.currentTimeMillis()
            recoveredStale = dao.recoverStaleInProgress(
                startedAt - IN_PROGRESS_LEASE_MS,
                startedAt
            )
            recoveredLegacy = dao.recoverLegacyRetryExhaustion(startedAt)

            val processor = OutboxProcessor(
                transportOverride ?: GatewayTransportFactory.create(applicationContext)
            )

            while (processed < MAX_EVENTS_PER_RUN) {
                val ready = dao.getReadyOutboxEvents(
                    System.currentTimeMillis(),
                    minOf(BATCH_SIZE, MAX_EVENTS_PER_RUN - processed)
                )
                if (ready.isEmpty()) break

                var claimedInBatch = 0
                ready.forEach { event ->
                    if (dao.claimReadyOutbox(event.eventId, System.currentTimeMillis()) == 1) {
                        claimedInBatch += 1
                        processed += 1
                        when (processor.process(event, dao::updateOutbox)) {
                            OutboxStatus.SUCCESS -> succeeded += 1
                            OutboxStatus.RETRY -> retrying += 1
                            OutboxStatus.FAILED -> failed += 1
                            else -> Unit
                        }
                    }
                }
                if (claimedInBatch == 0) break
            }

            scheduleRemainingWork(dao.getEarliestScheduledOutboxAt())
            Log.i(
                TAG,
                "Outbox drain complete processed=$processed success=$succeeded " +
                    "retry=$retrying failed=$failed recoveredStale=$recoveredStale " +
                    "recoveredLegacy=$recoveredLegacy"
            )
            Result.success()
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Exception) {
            Log.e(TAG, "Outbox drain failed", error)
            Result.retry()
        } finally {
            if (OutboxUiRefreshPolicy.shouldNotify(
                    recoveredStale = recoveredStale,
                    recoveredLegacy = recoveredLegacy,
                    processed = processed
                )
            ) {
                PocEventChangeNotifier.notify(applicationContext)
            }
        }
    }

    private fun scheduleRemainingWork(nextAttemptAt: Long?) {
        nextAttemptAt ?: return
        val delay = max(0L, nextAttemptAt - System.currentTimeMillis())
        OutboxScheduler.scheduleRetryWake(applicationContext, delay)
    }
}

internal object OutboxUiRefreshPolicy {
    fun shouldNotify(
        recoveredStale: Int,
        recoveredLegacy: Int,
        processed: Int
    ): Boolean = recoveredStale > 0 || recoveredLegacy > 0 || processed > 0
}
