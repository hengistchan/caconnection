package com.caconnection.telephony.call

import android.telecom.Call
import android.telecom.CallScreeningService
import android.os.Build
import android.util.Log
import com.caconnection.data.poc.CallIdentityEventEntity
import com.caconnection.data.poc.PocEventStore
import com.caconnection.telephony.subscription.SubscriptionRepository
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Observe-only call screening service.
 *
 * Every incoming call is immediately allowed. The service never blocks,
 * rejects, silences, hides, or removes a call from the system call log.
 */
class GatewayCallScreeningService : CallScreeningService() {
    override fun onScreenCall(callDetails: Call.Details) {
        if (callDetails.callDirection != Call.Details.DIRECTION_INCOMING) return

        val observedAt = System.currentTimeMillis()
        val response = CallResponse.Builder()
            .setDisallowCall(false)
            .setRejectCall(false)
            .setSilenceCall(false)
            .setSkipCallLog(false)
            .setSkipNotification(false)
            .build()

        runCatching {
            respondToCall(callDetails, response)
        }.onFailure {
            Log.e(TAG, "Unable to return allow-call response", it)
            return
        }
        val respondedAt = System.currentTimeMillis()

        val telecomCallIdHash =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
                callDetails.id?.let(::sha256)
            } else {
                null
            }
        val callerAddress = callDetails.handle?.schemeSpecificPart
        val callerDisplayName = callDetails.callerDisplayName
        val handlePresentation = callDetails.handlePresentation
        val displayNamePresentation = callDetails.callerDisplayNamePresentation
        val phoneAccountId = callDetails.accountHandle?.id
        val verificationStatus = callDetails.callerNumberVerificationStatus

        persistenceExecutor.schedule({
            runCatching {
                val directResolution = CallPhoneAccountResolver.resolve(
                    phoneAccountId,
                    SubscriptionRepository(this).getActiveSubscriptions()
                )
                val resolution = if (directResolution.subscriptionId != null) {
                    directResolution
                } else {
                    CallStateMonitor.resolveRecentActiveCall(observedAt)
                        ?: directResolution
                }
                CallIdentityEventEntity(
                    UUID.randomUUID().toString(),
                    telecomCallIdHash,
                    callerAddress,
                    callerDisplayName,
                    handlePresentation,
                    displayNamePresentation,
                    phoneAccountId,
                    resolution.subscriptionId,
                    resolution.slotIndex,
                    resolution.method,
                    resolution.confidence,
                    resolution.notes,
                    verificationStatus,
                    observedAt,
                    respondedAt,
                    DECISION_ALLOW
                )
            }.onSuccess { event ->
                PocEventStore.get(this).insertCallIdentityWithOutbox(event)
            }.onFailure {
                // Never log Call.Details or the address; both may contain the
                // caller's number.
                Log.e(TAG, "Unable to persist incoming-call identity metadata", it)
            }
        }, CORRELATION_DELAY_MS, TimeUnit.MILLISECONDS)
    }

    private fun sha256(value: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(StandardCharsets.UTF_8))
            .joinToString(separator = "") { byte -> "%02x".format(byte) }

    companion object {
        private const val TAG = "GatewayCallScreening"
        const val DECISION_ALLOW = "ALLOW"
        private const val CORRELATION_DELAY_MS = 300L
        private val persistenceExecutor =
            Executors.newSingleThreadScheduledExecutor()
    }
}
