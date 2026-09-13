package com.caconnection.notifications

import org.junit.Assert.assertEquals
import org.junit.Test

class NotificationAllowlistTest {
    @Test
    fun parsesPackagesAcrossSupportedSeparatorsAndDropsInvalidEntries() {
        val result = NotificationAllowlist.parse(
            """
            com.example.alpha
            com.example.beta, org.example.chat;invalid
            com.example.alpha
            """.trimIndent()
        )

        assertEquals(
            sortedSetOf(
                "com.example.alpha",
                "com.example.beta",
                "org.example.chat"
            ),
            result
        )
    }

    @Test
    fun emptyInputProducesDenyAllAllowlist() {
        assertEquals(emptySet<String>(), NotificationAllowlist.parse(" \n, ; "))
    }
}
