package com.caconnection.telephony.subscription

data class SubscriptionSnapshot(
    val subscriptionId: Int,
    val slotIndex: Int,
    val displayName: String,
    val carrierName: String,
    val countryIso: String,
    val isEmbedded: Boolean,
    val isOpportunistic: Boolean
) {
    val lineLabel: String
        get() = "SIM${slotIndex + 1} ${carrierName.ifBlank { displayName.ifBlank { "Unknown carrier" } }}"
}
