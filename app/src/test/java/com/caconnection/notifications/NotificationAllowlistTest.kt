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

    @Test
    fun recommendedDefaultsPreserveExistingPackages() {
        assertEquals(
            sortedSetOf(
                "com.android.mms",
                "com.example.existing"
            ),
            NotificationAllowlist.mergeRecommended(
                setOf(
                    "com.example.existing",
                    "com.ss.android.lark",
                    "com.ss.android.lark.kami",
                    "com.ss.android.lark.saxmsa667"
                )
            )
        )
    }

    @Test
    fun feishuPackagesAreRejectedAsWebhookLoopSources() {
        assertEquals(
            sortedSetOf("com.android.mms", "com.tencent.mm"),
            NotificationAllowlist.parse(
                """
                com.android.mms
                com.ss.android.lark
                com.ss.android.lark.kami
                com.ss.android.lark.saxmsa667
                com.tencent.mm
                """.trimIndent()
            )
        )
    }

    @Test
    fun onlyFeishuPackageFamilyIsTreatedAsWebhookLoopSource() {
        assertEquals(true, NotificationAllowlist.isWebhookLoopSource("com.ss.android.lark"))
        assertEquals(true, NotificationAllowlist.isWebhookLoopSource("com.ss.android.lark.kami"))
        assertEquals(false, NotificationAllowlist.isWebhookLoopSource("com.ss.android.ugc.aweme"))
    }
}
