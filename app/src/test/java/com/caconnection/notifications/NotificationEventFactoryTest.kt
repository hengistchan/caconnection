package com.caconnection.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationEventFactoryTest {
    @Test
    fun capturesTitleBodyPresenceAndLength() {
        val metadata = NotificationEventFactory.content(
            title = "Bank alert",
            text = "Code 123456"
        )

        assertEquals("Bank alert", metadata.title)
        assertEquals("Code 123456", metadata.body)
        assertTrue(metadata.titleExposed)
        assertTrue(metadata.textExposed)
        assertEquals(10, metadata.titleLength)
        assertEquals(11, metadata.textLength)
    }

    @Test
    fun nullAndEmptyContentAreNotExposed() {
        val metadata = NotificationEventFactory.content(null, "")

        assertEquals(null, metadata.title)
        assertEquals(null, metadata.body)
        assertFalse(metadata.titleExposed)
        assertFalse(metadata.textExposed)
        assertEquals(0, metadata.titleLength)
        assertEquals(0, metadata.textLength)
    }
}
