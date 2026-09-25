package com.caconnection.worker

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.caconnection.data.poc.OutgoingSmsEventEntity
import com.caconnection.data.poc.OutgoingStatus
import com.caconnection.data.poc.PocEventStore
import com.caconnection.telephony.outbound.SmsGatewaySender
import com.caconnection.telephony.subscription.SubscriptionRepository
import com.caconnection.transport.GatewayTransportConfig
import com.caconnection.transport.RemoteCommandClaimResult
import com.caconnection.transport.RemoteCommandClient
import com.caconnection.transport.RemoteSmsCommand

class RemoteCommandWorker(
    context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {
    internal var clientOverride: RemoteCommandClient? = null

    override suspend fun doWork(): Result {
        // Reconcile old local dispatch attempts on every durable poll. This
        // covers a process that stays alive but never receives modem callbacks,
        // while the startup reconciliation covers process death/recreation.
        SmsGatewaySender(applicationContext).recoverInterrupted()
        val settings = GatewayTransportConfig.load(applicationContext)
        if (!settings.enabled || !settings.configured) {
            RemoteCommandScheduler.enqueue(
                applicationContext,
                RemoteCommandScheduler.UNCONFIGURED_POLL_DELAY_MS
            )
            return Result.success()
        }
        return when (
            val result = clientOverride?.claim()
                ?: RemoteCommandClient(settings).claim()
        ) {
            is RemoteCommandClaimResult.Success -> {
                // One bad command must not discard the batch: report each
                // rejection to the server and execute the survivors.
                result.rejected.forEach(::reportRejected)
                result.commands.forEach(::execute)
                // A stream nudge is one-shot: extending the poll chain from
                // it would grow that chain with every command. The chain is
                // re-cadenced only by its own runs (ADR-003).
                if (!isNudgeRun()) {
                    RemoteCommandScheduler.enqueue(
                        applicationContext,
                        RemoteCommandScheduler.nextPollDelay()
                    )
                }
                Result.success()
            }

            is RemoteCommandClaimResult.RetryableFailure -> {
                if (isNudgeRun()) {
                    // Leave retry pacing to WorkManager; the poll chain
                    // remains the fallback either way.
                    return Result.retry()
                }
                result.retryAfterMillis?.let {
                    RemoteCommandScheduler.enqueue(applicationContext, it)
                    return Result.success()
                }
                Result.retry()
            }

            is RemoteCommandClaimResult.PermanentFailure -> {
                if (!isNudgeRun()) {
                    RemoteCommandScheduler.enqueue(
                        applicationContext,
                        RemoteCommandScheduler.UNCONFIGURED_POLL_DELAY_MS
                    )
                }
                Result.success()
            }
        }
    }

    private fun isNudgeRun(): Boolean =
        inputData.getBoolean(RemoteCommandScheduler.KEY_NUDGE, false)

    private fun execute(command: RemoteSmsCommand) {
        val subscriptions = SubscriptionRepository(applicationContext)
            .getActiveSubscriptions()
        val subscription = subscriptions.firstOrNull {
            it.slotIndex == command.slotIndex
        }
        if (subscription == null) {
            // Transient: the telephony stack may still be loading (boot, SIM
            // hot-swap, eSIM toggle) or the slot list is empty. Terminal FAILED
            // here would burn a command that is sendable seconds later. Report
            // nothing — the server lease requeues the row and a later poll
            // retries it within the TTL.
            Log.w(
                TAG,
                "SIM slot ${command.slotIndex} unavailable; deferring command ${command.commandId}"
            )
            return
        }
        if (
            ContextCompat.checkSelfPermission(
                applicationContext,
                Manifest.permission.SEND_SMS
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            recordFailure(command.commandId, command.recipient, command.body, command.slotIndex, "SEND_SMS permission is not granted")
            return
        }
        SmsGatewaySender(applicationContext).sendRemote(
            commandId = command.commandId,
            recipient = command.recipient,
            body = command.body,
            subscription = subscription,
            onRejected = { reason ->
                recordFailure(command.commandId, command.recipient, command.body, command.slotIndex, reason)
            }
        )
    }

    private fun reportRejected(rejected: RemoteCommandClaimResult.RejectedCommand) {
        val commandId = rejected.commandId ?: return
        recordFailure(commandId, "", "", 0, rejected.reason)
    }

    private fun recordFailure(
        commandId: String,
        recipient: String,
        body: String,
        slotIndex: Int,
        reason: String
    ) {
        val now = System.currentTimeMillis()
        PocEventStore.get(applicationContext).insertRemoteCommandFailure(
            OutgoingSmsEventEntity(
                commandId,
                recipient,
                body,
                now,
                now,
                -1,
                slotIndex,
                "",
                commandId,
                OutgoingStatus.FAILED.name,
                0,
                0,
                0,
                1,
                null,
                reason.take(256),
                "NOT_ATTEMPTED",
                null,
                null
            )
        )
    }

    companion object {
        private const val TAG = "RemoteCommandWorker"
    }
}
