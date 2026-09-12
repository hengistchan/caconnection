package com.caconnection.telephony.outbound

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SmsGatewaySenderTest {
    @Test
    fun acceptsInternationalPhoneNumberAndBody() {
        assertNull(SmsGatewaySender.validate("+8613800138000", "POC test"))
    }

    @Test
    fun acceptsNumericShortCode() {
        assertNull(SmsGatewaySender.validate("10086", "查询"))
    }

    @Test
    fun rejectsBlankRecipient() {
        assertEquals("Recipient is required", SmsGatewaySender.validate("", "hello"))
    }

    @Test
    fun rejectsBlankBody() {
        assertEquals("Message body is required", SmsGatewaySender.validate("10086", " "))
    }

    @Test
    fun rejectsAlphabeticRecipient() {
        assertEquals(
            "Recipient must be a phone number or short code",
            SmsGatewaySender.validate("not-a-number", "hello")
        )
    }
}
