package com.caconnection.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UiPrivacyTest {
    @Test
    fun extractsStandaloneOtpCandidate() {
        assertEquals("382941", UiPrivacy.extractOtp("Your verification code is 382941."))
        assertNull(UiPrivacy.extractOtp("Order 123456789 is ready"))
    }

    @Test
    fun masksAddressesButKeepsUsefulSuffix() {
        assertEquals("••••1234", UiPrivacy.maskAddress("+86 138 0000 1234", "unknown"))
        assertEquals("unknown", UiPrivacy.maskAddress("", "unknown"))
    }

    @Test
    fun sanitizesUrlsSecretsAndLongNumbers() {
        val value =
            "POST https://gateway.example.test/v1/events secret=" +
                "abcdefghijklmnopqrstuvwxyzABCDEFG1234567890 phone=13800001234"
        val sanitized = UiPrivacy.sanitizeDiagnosticText(value)

        assertTrue(sanitized.contains("[URL]"))
        assertTrue(sanitized.contains("[REDACTED]"))
        assertTrue(sanitized.contains("••••1234"))
        assertFalse(sanitized.contains("gateway.example.test"))
        assertFalse(sanitized.contains("abcdefghijklmnopqrstuvwxyz"))
        assertFalse(sanitized.contains("13800001234"))
    }
}
