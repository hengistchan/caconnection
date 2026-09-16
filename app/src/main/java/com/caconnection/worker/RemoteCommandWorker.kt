package com.caconnection.worker

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
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
                result.commands.forEach(::execute)
                RemoteCommandScheduler.enqueue(
                    applicationContext,
                    RemoteCommandScheduler.NORMAL_POLL_DELAY_MS
                )
                Result.success()
            }

            is RemoteCommandClaimResult.RetryableFailure -> {
                result.retryAfterMillis?.let {
                    RemoteCommandScheduler.enqueue(applicationContext, it)
                    return Result.success()
                }
                Result.retry()
            }

            is RemoteCommandClaimResult.PermanentFailure -> {
                RemoteCommandScheduler.enqueue(
                    applicationContext,
                    RemoteCommandScheduler.UNCONFIGURED_POLL_DELAY_MS
                )
                Result.success()
            }
        }
    }

    private fun execute(command: RemoteSmsCommand) {
        val subscriptions = SubscriptionRepository(applicationContext)
            .getActiveSubscriptions()
        val subscription = subscriptions.firstOrNull {
            it.slotIndex == command.slotIndex
        }
        if (subscription == null) {
            recordFailure(command, "Requested SIM is not active")
            return
        }
        if (
            ContextCompat.checkSelfPermission(
                applicationContext,
                Manifest.permission.SEND_SMS
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            recordFailure(command, "SEND_SMS permission is not granted")
            return
        }
        SmsGatewaySender(applicationContext).sendRemote(
            commandId = command.commandId,
            recipient = command.recipient,
            body = command.body,
            subscription = subscription,
            onRejected = { reason -> recordFailure(command, reason) }
        )
    }

    private fun recordFailure(command: RemoteSmsCommand, reason: String) {
        val now = System.currentTimeMillis()
        PocEventStore.get(applicationContext).insertRemoteCommandFailure(
            OutgoingSmsEventEntity(
                command.commandId,
                command.recipient,
                command.body,
                now,
                now,
                -1,
                command.slotIndex,
                "",
                command.commandId,
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
}
