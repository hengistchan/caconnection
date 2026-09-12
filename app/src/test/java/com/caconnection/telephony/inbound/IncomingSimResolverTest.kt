package com.caconnection.telephony.inbound

import android.provider.Telephony
import android.telephony.SubscriptionManager
import com.caconnection.telephony.subscription.SubscriptionSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class IncomingSimResolverTest {
    private val subscriptions = listOf(
        SubscriptionSnapshot(4, 0, "CMCC", "China Mobile", "cn", false, false),
        SubscriptionSnapshot(7, 1, "UNICOM", "China Unicom", "cn", false, false)
    )

    @Test
    fun receivedBroadcastTreatsSubscriptionAsOemBehavior() {
        val result = IncomingSimResolver.resolve(
            Telephony.Sms.Intents.SMS_RECEIVED_ACTION,
            mapOf("subscription" to 7, "slot" to 1),
            subscriptions
        )

        assertEquals(7, result.subscriptionId)
        assertEquals(1, result.slotIndex)
        assertEquals(ResolutionMethod.OEM_SUBSCRIPTION_EXTRA, result.method)
        assertEquals(ResolutionConfidence.HIGH, result.confidence)
    }

    @Test
    fun receivedBroadcastDoesNotMislabelPlatformNamedKeyAsContract() {
        val result = IncomingSimResolver.resolve(
            Telephony.Sms.Intents.SMS_RECEIVED_ACTION,
            mapOf(SubscriptionManager.EXTRA_SUBSCRIPTION_INDEX to 4),
            subscriptions
        )

        assertEquals(ResolutionMethod.OEM_SUBSCRIPTION_EXTRA, result.method)
        assertEquals(0, result.slotIndex)
    }

    @Test
    fun deliverBroadcastUsesDefaultSmsMethod() {
        val result = IncomingSimResolver.resolve(
            Telephony.Sms.Intents.SMS_DELIVER_ACTION,
            mapOf("subscription" to 7, "slot" to 1),
            subscriptions
        )

        assertEquals(ResolutionMethod.DEFAULT_SMS_DELIVER, result.method)
        assertEquals(ResolutionConfidence.HIGH, result.confidence)
    }

    @Test
    fun slotOnlyCrossReferencesActiveSubscription() {
        val result = IncomingSimResolver.resolve(
            Telephony.Sms.Intents.SMS_RECEIVED_ACTION,
            mapOf("phone" to 0),
            subscriptions
        )

        assertEquals(4, result.subscriptionId)
        assertEquals(0, result.slotIndex)
        assertEquals(ResolutionMethod.OEM_SLOT_EXTRA, result.method)
        assertEquals(ResolutionConfidence.MEDIUM, result.confidence)
    }

    @Test
    fun conflictingSubscriptionAndSlotIsLowConfidence() {
        val result = IncomingSimResolver.resolve(
            Telephony.Sms.Intents.SMS_RECEIVED_ACTION,
            mapOf("subscription" to 7, "slot" to 0),
            subscriptions
        )

        assertEquals(7, result.subscriptionId)
        assertEquals(1, result.slotIndex)
        assertEquals(ResolutionConfidence.LOW, result.confidence)
    }

    @Test
    fun noCandidatesIsUnresolved() {
        val result = IncomingSimResolver.resolve(
            Telephony.Sms.Intents.SMS_RECEIVED_ACTION,
            mapOf("format" to "3gpp"),
            subscriptions
        )

        assertNull(result.subscriptionId)
        assertNull(result.slotIndex)
        assertEquals(ResolutionMethod.UNRESOLVED, result.method)
        assertEquals(ResolutionConfidence.NONE, result.confidence)
    }
}
