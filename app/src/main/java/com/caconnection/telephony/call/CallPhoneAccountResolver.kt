package com.caconnection.telephony.call

import com.caconnection.telephony.subscription.SubscriptionSnapshot

data class CallPhoneAccountResolution(
    val subscriptionId: Int?,
    val slotIndex: Int?,
    val method: String,
    val confidence: String,
    val notes: String
)

object CallPhoneAccountResolver {
    fun resolve(
        phoneAccountId: String?,
        subscriptions: List<SubscriptionSnapshot>
    ): CallPhoneAccountResolution {
        val accountId = phoneAccountId?.trim().orEmpty()
        val subscription = subscriptions.singleOrNull {
            it.subscriptionId.toString() == accountId
        }
        return if (subscription != null) {
            CallPhoneAccountResolution(
                subscriptionId = subscription.subscriptionId,
                slotIndex = subscription.slotIndex,
                method = "PHONE_ACCOUNT_ID",
                confidence = "HIGH",
                notes = "PhoneAccountHandle.id exactly matched active subscriptionId"
            )
        } else {
            CallPhoneAccountResolution(
                subscriptionId = null,
                slotIndex = null,
                method = "UNRESOLVED",
                confidence = "NONE",
                notes = if (accountId.isEmpty()) {
                    "Call details did not expose a phone account ID"
                } else {
                    "Phone account ID did not exactly match one active subscription"
                }
            )
        }
    }
}
