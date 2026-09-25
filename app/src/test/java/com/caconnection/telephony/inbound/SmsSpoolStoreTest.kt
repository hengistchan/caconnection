package com.caconnection.telephony.inbound

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class SmsSpoolStoreTest {
    @get:Rule
    val folder = TemporaryFolder()

    @Test
    fun completeInterruptedWriteIsPromotedWhenJsonMissing() {
        val temporary = file("evt-1.json.tmp", COMPLETE_ENTRY)

        SmsSpoolStore.recoverInterruptedWrites(folder.root)

        val promoted = folder.root.resolve("evt-1.json")
        assertTrue(promoted.exists())
        assertEquals(COMPLETE_ENTRY, promoted.readText())
        assertFalse(temporary.exists())
    }

    @Test
    fun tornInterruptedWriteIsQuarantinedNotSilentlyDropped() {
        // Cut mid-object: no closing brace, no promotion.
        val temporary = file("evt-2.json.tmp", """{"eventId":"evt-2","receivedAt":178""")

        SmsSpoolStore.recoverInterruptedWrites(folder.root)

        assertFalse(folder.root.resolve("evt-2.json").exists())
        assertFalse(temporary.exists())
        assertTrue(folder.root.resolve("evt-2.json.tmp.corrupt").exists())
    }

    @Test
    fun completeTemporaryReplacesOlderSiblingEntry() {
        // update() wrote the tmp, then the process died before the rename.
        val older = COMPLETE_ENTRY.replace("\"body\":\"hi\"", "\"body\":\"staged\"")
        file("evt-3.json", older)
        val temporary = file("evt-3.json.tmp", COMPLETE_ENTRY)

        SmsSpoolStore.recoverInterruptedWrites(folder.root)

        assertFalse(temporary.exists())
        assertEquals(COMPLETE_ENTRY, folder.root.resolve("evt-3.json").readText())
    }

    /**
     * Gson's lenient parser accepts a document with silently missing fields.
     * A write that ends on a value boundary but lost the tail must not be
     * promoted as if it were complete.
     */
    @Test
    fun jsonMissingRequiredFieldsIsNotTreatedAsComplete() {
        val file = file("evt-4.json.tmp", """{"action":"SMS_RECEIVED"}""")

        assertFalse(SmsSpoolStore.isCompleteEntry(file))

        SmsSpoolStore.recoverInterruptedWrites(folder.root)

        assertFalse(folder.root.resolve("evt-4.json").exists())
        assertTrue(folder.root.resolve("evt-4.json.tmp.corrupt").exists())
    }

    @Test
    fun zeroReceivedAtIsNotTreatedAsComplete() {
        val file = file(
            "evt-5.json.tmp",
            COMPLETE_ENTRY.replace("\"receivedAt\":1789189395000", "\"receivedAt\":0")
        )

        assertFalse(SmsSpoolStore.isCompleteEntry(file))
    }

    @Test
    fun completeEntryPassesValidation() {
        assertTrue(SmsSpoolStore.isCompleteEntry(file("evt-6.json.tmp", COMPLETE_ENTRY)))
    }

    private fun file(name: String, content: String) =
        folder.root.resolve(name).apply { writeText(content) }

    private companion object {
        const val COMPLETE_ENTRY =
            """{"eventId":"evt-3","action":"android.provider.Telephony.SMS_RECEIVED",""" +
                """"originatingAddress":"+15551234567","body":"hi",""" +
                """"receivedAt":1789189395000,"persistedAt":1789189396000,"partCount":1,""" +
                """"resolvedSubscriptionId":null,"resolvedSlotIndex":null,""" +
                """"resolutionMethod":null,"resolutionConfidence":null,"resolutionNotes":null,""" +
                """"rawExtras":null,"providerWriteStatus":"PENDING","providerUri":null,""" +
                """"providerWriteError":null,"idempotencyKey":"sms_abc"}"""
    }
}
