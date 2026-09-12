package com.caconnection.telephony.inbound

import android.provider.Telephony
import android.telephony.SubscriptionManager
import com.caconnection.telephony.subscription.SubscriptionSnapshot

enum class ResolutionMethod {
    OFFICIAL_SUBSCRIPTION_EXTRA,
    OEM_SUBSCRIPTION_EXTRA,
    OEM_SLOT_EXTRA,
    DEFAULT_SMS_DELIVER,
    UNRESOLVED
}

enum class ResolutionConfidence {
    HIGH,
    MEDIUM,
    LOW,
    NONE
}

data class IncomingSimResolution(
    val subscriptionId: Int?,
    val slotIndex: Int?,
    val method: ResolutionMethod,
    val confidence: ResolutionConfidence,
    val notes: String
)

object IncomingSimResolver {
    private val subscriptionKeys = listOf(
        "subscription",
        SubscriptionManager.EXTRA_SUBSCRIPTION_INDEX,
        "subId",
        "subscriptionId",
        "android.telephony.extra.SUBSCRIPTION_ID"
    )

    private val slotKeys = listOf(
        "slot",
        SubscriptionManager.EXTRA_SLOT_INDEX,
        "slotId",
        "simSlot",
        "simSlotIndex",
        "phone",
        "phoneId"
    )

    fun resolve(
        action: String?,
        extras: Map<String, Any?>,
        subscriptions: List<SubscriptionSnapshot>
    ): IncomingSimResolution {
        val isDeliver = action == Telephony.Sms.Intents.SMS_DELIVER_ACTION
        val subCandidate = firstInt(extras, subscriptionKeys)
        val slotCandidate = firstInt(extras, slotKeys)
        val bySub = subCandidate?.let { candidate ->
            subscriptions.firstOrNull { it.subscriptionId == candidate }
        }
        val bySlot = slotCandidate?.let { candidate ->
            subscriptions.firstOrNull { it.slotIndex == candidate }
        }

        if (subCandidate != null) {
            val resolvedSlot = bySub?.slotIndex ?: slotCandidate
            val conflict = bySub != null && slotCandidate != null && bySub.slotIndex != slotCandidate
            val method = if (isDeliver) {
                ResolutionMethod.DEFAULT_SMS_DELIVER
            } else {
                ResolutionMethod.OEM_SUBSCRIPTION_EXTRA
            }
            val confidence = when {
                conflict -> ResolutionConfidence.LOW
                isDeliver && bySub != null -> ResolutionConfidence.HIGH
                bySub != null -> ResolutionConfidence.HIGH
                isDeliver -> ResolutionConfidence.MEDIUM
                else -> ResolutionConfidence.LOW
            }
            val notes = when {
                conflict ->
                    "subscription=$subCandidate maps to slot=${bySub?.slotIndex}, but intent reported slot=$slotCandidate"
                bySub != null ->
                    "subscription extra matched active ${bySub.lineLabel}"
                else ->
                    "subscription=$subCandidate was present but did not match the current active subscription list"
            }
            return IncomingSimResolution(subCandidate, resolvedSlot, method, confidence, notes)
        }

        if (slotCandidate != null) {
            val method = if (isDeliver) {
                ResolutionMethod.DEFAULT_SMS_DELIVER
            } else {
                ResolutionMethod.OEM_SLOT_EXTRA
            }
            return IncomingSimResolution(
                subscriptionId = bySlot?.subscriptionId,
                slotIndex = slotCandidate,
                method = method,
                confidence = if (bySlot != null) ResolutionConfidence.MEDIUM else ResolutionConfidence.LOW,
                notes = if (bySlot != null) {
                    "slot extra matched active ${bySlot.lineLabel}"
                } else {
                    "slot=$slotCandidate was present but did not match the current active subscription list"
                }
            )
        }

        return IncomingSimResolution(
            subscriptionId = null,
            slotIndex = null,
            method = ResolutionMethod.UNRESOLVED,
            confidence = ResolutionConfidence.NONE,
            notes = "No subscription or slot candidate was present in the broadcast extras"
        )
    }

    private fun firstInt(extras: Map<String, Any?>, keys: List<String>): Int? {
        for (key in keys) {
            val value = extras[key] ?: continue
            val parsed = when (value) {
                is Int -> value
                is Long -> value.toInt()
                is Short -> value.toInt()
                is String -> value.toIntOrNull()
                else -> null
            }
            if (parsed != null && parsed >= 0) return parsed
        }
        return null
    }
}
