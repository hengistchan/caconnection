package com.caconnection.worker

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import com.caconnection.transport.CommandStreamState
import java.util.concurrent.TimeUnit
import kotlin.math.max

object RemoteCommandScheduler {
    private const val TAG = "RemoteCommandScheduler"
    private const val UNIQUE_WORK = "remote_sms_command_poll"
    private const val UNIQUE_NUDGE_WORK = "remote_sms_command_nudge"

    /** Set on work triggered by the command stream — see [nudge]. */
    const val KEY_NUDGE = "remote_command_nudge"

    const val NORMAL_POLL_DELAY_MS = 15_000L

    /**
     * WorkManager is a fallback, not a 15-second scheduler (ADR-003). While
     * the command stream carries the fast path, polling only reconciles.
     */
    const val RECONCILE_POLL_DELAY_MS = 15 * 60_000L
    const val UNCONFIGURED_POLL_DELAY_MS = 15 * 60_000L

    fun enqueueNow(context: Context) = enqueue(context, 0L)

    /**
     * The stream just said commands are queued: claim immediately on its own
     * unique work. REPLACE (not the poll chain's APPEND) so the nudge is not
     * stuck behind a slow scheduled poll, and the nudge never extends the
     * poll chain — a busy command day must not grow a work queue.
     */
    fun nudge(context: Context) {
        val request = buildRequest(
            delayMillis = 0L,
            inputData = workDataOf(KEY_NUDGE to true)
        )
        runCatching {
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniqueWork(
                    UNIQUE_NUDGE_WORK,
                    ExistingWorkPolicy.REPLACE,
                    request
                )
        }.onFailure {
            Log.e(TAG, "Unable to schedule remote command nudge", it)
        }
    }

    /**
     * Poll cadence follows the availability channel: fast fallback while the
     * stream is down, sparse reconcile while it carries command latency.
     */
    fun nextPollDelay(): Long =
        if (CommandStreamState.connected) {
            RECONCILE_POLL_DELAY_MS
        } else {
            NORMAL_POLL_DELAY_MS
        }

    fun enqueue(context: Context, delayMillis: Long) {
        runCatching {
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniqueWork(
                    UNIQUE_WORK,
                    ExistingWorkPolicy.APPEND_OR_REPLACE,
                    buildRequest(delayMillis)
                )
        }.onFailure {
            Log.e(TAG, "Unable to schedule remote command polling", it)
        }
    }

    /**
     * Drop whatever cadence the poll chain is on and restart it at
     * [delayMillis]. Used when the command stream connects (relax to
     * reconcile) or drops (restore the fast fallback) — an APPEND would run
     * behind the stale delay instead of replacing it. Cancelling an in-flight
     * claim is safe: the server lease requeues anything it already took.
     */
    fun reschedulePolling(context: Context, delayMillis: Long) {
        runCatching {
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniqueWork(
                    UNIQUE_WORK,
                    ExistingWorkPolicy.REPLACE,
                    buildRequest(delayMillis)
                )
        }.onFailure {
            Log.e(TAG, "Unable to reschedule remote command polling", it)
        }
    }

    private fun buildRequest(
        delayMillis: Long,
        inputData: androidx.work.Data = workDataOf()
    ) = OneTimeWorkRequestBuilder<RemoteCommandWorker>()
        .setInitialDelay(max(0L, delayMillis), TimeUnit.MILLISECONDS)
        .setInputData(inputData)
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
}
