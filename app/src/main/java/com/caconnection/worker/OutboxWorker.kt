package com.caconnection.worker

import android.content.Context
import android.os.PowerManager
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.caconnection.data.poc.PocEventChangeNotifier
import com.caconnection.data.poc.PocDatabase
import com.caconnection.data.poc.OutboxStatus
import com.caconnection.transport.GatewayTransportFactory
import com.caconnection.transport.GatewayHealthStore
import com.caconnection.transport.GatewayRateLimitStore
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
        private const val IN_PROGRESS_LEASE_MS = 2 * 60 * 1_000L
        private const val SUCCESS_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000L
        const val KEY_RETRY_WAKE = "retry_wake"
    }

    internal var transportOverride: Transport? = null

    override suspend fun doWork(): Result {
        if (inputData.getBoolean(KEY_RETRY_WAKE, false)) {
            Log.i(TAG, "Retry wake fired; handing off to immediate drain")
            OutboxScheduler.markRetryWakeConsumed(applicationContext)
            OutboxScheduler.enqueueRecoveryNow(applicationContext, "retry_wake")
            return Result.success()
        }
        val gateDelayMs = GatewayRateLimitStore.acquireRequestSlot(
            applicationContext,
            "outbox"
        )
        if (gateDelayMs > 0L) {
            Log.w(
                TAG,
                "Skipping outbox network attempt while Gateway gate is closed " +
                    "remainingMs=$gateDelayMs source=${GatewayRateLimitStore.lastSource(applicationContext)}"
            )
            OutboxScheduler.scheduleRetryWake(applicationContext, gateDelayMs)
            return Result.success()
        }

        // Hold a partial wake lock so HyperOS / Doze cannot suspend the CPU
        // mid-batch.  Without this, the drain stalls until the device wakes.
        val powerManager = applicationContext
            .getSystemService(Context.POWER_SERVICE) as PowerManager
        val wakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "caconnection:outbox_drain"
        )
        wakeLock.acquire(10 * 60 * 1_000L) // hard safety timeout 10 min

        val dao = PocDatabase.get(applicationContext).pocDao()
        var recoveredStale = 0
        var recoveredLegacy = 0
        var processed = 0
        var succeeded = 0
        var retrying = 0
        var failed = 0
        return try {
            val startedAt = System.currentTimeMillis()
            GatewayHealthStore.markOutboxDrainStarted(applicationContext, startedAt)
            val oldestAt = dao.getOldestActiveOutboxCreatedAt()
            Log.i(
                TAG,
                "Outbox drain started pending=${dao.countActiveOutboxEvents()} " +
                    "oldestAgeMs=${oldestAt?.let { startedAt - it } ?: 0L}"
            )
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
                var retryableFailureInBatch = false
                for (event in ready) {
                    if (dao.claimReadyOutbox(event.eventId, System.currentTimeMillis()) == 1) {
                        claimedInBatch += 1
                        processed += 1
                        when (processor.process(event, dao::updateOutbox)) {
                            OutboxStatus.SUCCESS -> succeeded += 1
                            OutboxStatus.RETRY -> {
                                retrying += 1
                                retryableFailureInBatch = true
                            }
                            OutboxStatus.FAILED -> failed += 1
                            else -> Unit
                        }
                    }
                    // A retryable transport failure (especially HTTP 429)
                    // applies to the shared Gateway path, not just this row.
                    // Stop the batch immediately so the remaining durable
                    // rows do not amplify the outage or refresh rate limits.
                    if (retryableFailureInBatch) {
                        Log.w(
                            TAG,
                            "Stopping outbox batch after retryable failure " +
                                "processed=$processed remaining=${ready.size - claimedInBatch}"
                        )
                        break
                    }
                }
                if (claimedInBatch == 0 || retryableFailureInBatch) break
            }

            scheduleRemainingWork(dao.getEarliestScheduledOutboxAt())
            // SUCCESS rows hold copies of sender/body payloads; prune old ones
            // instead of accumulating them until a manual history clear.
            val pruned = dao.clearSuccessfulOutboxEventsBefore(
                startedAt - SUCCESS_RETENTION_MS
            )
            if (pruned > 0) Log.i(TAG, "Pruned $pruned settled outbox rows")
            Log.i(
                TAG,
                "Outbox drain complete processed=$processed success=$succeeded " +
                    "retry=$retrying failed=$failed recoveredStale=$recoveredStale " +
                    "recoveredLegacy=$recoveredLegacy"
            )
            // A worker that found no due rows, or only produced retry/failure
            // outcomes, is not transport-success evidence. Keep the previous
            // timestamp rather than making the diagnostics look healthy.
            if (succeeded > 0) {
                GatewayHealthStore.markOutboxDrainSucceeded(applicationContext)
            }
            Result.success()
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Exception) {
            GatewayHealthStore.markOutboxDrainFailed(applicationContext)
            Log.e(TAG, "Outbox drain failed", error)
            Result.retry()
        } finally {
            runCatching { if (wakeLock.isHeld) wakeLock.release() }
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
        if (nextAttemptAt == null) {
            OutboxScheduler.clearScheduledWake(applicationContext)
            return
        }
        val now = System.currentTimeMillis()
        val rowDelay = max(0L, nextAttemptAt - now)
        val sharedDelay = GatewayRateLimitStore.remainingMillis(applicationContext, now)
        val delay = max(rowDelay, sharedDelay)
        Log.i(
            TAG,
            "Scheduling remaining outbox work rowDelayMs=$rowDelay " +
                "sharedDelayMs=$sharedDelay effectiveDelayMs=$delay"
        )
        OutboxScheduler.scheduleRetryWake(applicationContext, delay, "remaining_work")
    }
}

internal object OutboxUiRefreshPolicy {
    fun shouldNotify(
        recoveredStale: Int,
        recoveredLegacy: Int,
        processed: Int
    ): Boolean = recoveredStale > 0 || recoveredLegacy > 0 || processed > 0
}
