package com.caconnection.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RedactedNotificationFactoryTest {
    @Test
    fun reportsOnlyPresenceAndLength() {
        val metadata = RedactedNotificationFactory.contentMetadata(
            title = "Bank alert",
            text = "Code 123456"
        )

        assertTrue(metadata.titleExposed)
        assertTrue(metadata.textExposed)
        assertEquals(10, metadata.titleLength)
        assertEquals(11, metadata.textLength)
        assertFalse(metadata.toString().contains("123456"))
    }

    @Test
    fun nullAndEmptyContentAreNotExposed() {
        val metadata = RedactedNotificationFactory.contentMetadata(null, "")

        assertFalse(metadata.titleExposed)
        assertFalse(metadata.textExposed)
        assertEquals(0, metadata.titleLength)
        assertEquals(0, metadata.textLength)
    }
}
