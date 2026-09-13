package com.caconnection.telephony.call

import com.caconnection.telephony.subscription.SubscriptionSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CallPhoneAccountResolverTest {
    private val subscriptions = listOf(
        SubscriptionSnapshot(1, 0, "SIM1", "Carrier A", "cn", false, false),
        SubscriptionSnapshot(2, 1, "SIM2", "Carrier B", "cn", false, false)
    )

    @Test
    fun exactPhoneAccountIdMapsToSubscriptionAndSlot() {
        val result = CallPhoneAccountResolver.resolve("2", subscriptions)

        assertEquals(2, result.subscriptionId)
        assertEquals(1, result.slotIndex)
        assertEquals("PHONE_ACCOUNT_ID", result.method)
        assertEquals("HIGH", result.confidence)
    }

    @Test
    fun whitespaceIsIgnoredAroundPhoneAccountId() {
        val result = CallPhoneAccountResolver.resolve(" 1 ", subscriptions)

        assertEquals(1, result.subscriptionId)
        assertEquals(0, result.slotIndex)
    }

    @Test
    fun ambiguousOrUnknownAccountDoesNotGuess() {
        val result = CallPhoneAccountResolver.resolve("99", subscriptions)

        assertNull(result.subscriptionId)
        assertNull(result.slotIndex)
        assertEquals("UNRESOLVED", result.method)
        assertEquals("NONE", result.confidence)
    }

    @Test
    fun missingAccountDoesNotGuess() {
        val result = CallPhoneAccountResolver.resolve(null, subscriptions)

        assertNull(result.subscriptionId)
        assertNull(result.slotIndex)
        assertEquals("UNRESOLVED", result.method)
    }
}
