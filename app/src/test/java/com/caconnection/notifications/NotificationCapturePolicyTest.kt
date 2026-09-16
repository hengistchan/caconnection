package com.caconnection.notifications

import android.app.Notification
import com.caconnection.data.poc.NotificationEventEntity
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationCapturePolicyTest {
    @Test
    fun dropsForegroundServiceAndGroupSummaryNoise() {
        assertFalse(
            NotificationCapturePolicy.isUserFacing(Notification.FLAG_FOREGROUND_SERVICE)
        )
        assertFalse(
            NotificationCapturePolicy.isUserFacing(Notification.FLAG_GROUP_SUMMARY)
        )
        assertFalse(
            NotificationCapturePolicy.isUserFacing(
                Notification.FLAG_FOREGROUND_SERVICE or Notification.FLAG_GROUP_SUMMARY
            )
        )
    }

    @Test
    fun acceptsOrdinaryUserFacingNotification() {
        assertTrue(NotificationCapturePolicy.isUserFacing(Notification.FLAG_AUTO_CANCEL))
        assertTrue(NotificationCapturePolicy.isUserFacing(0))
    }

    @Test
    fun suppressesOnlyMatchingEventsInsideTheWindow() {
        val deduplicator = NotificationEventDeduplicator(5_000L)
        val first = event("POSTED", 10, 20)
        val changed = event("POSTED", 10, 21)
        val removed = event("REMOVED", 10, 20)

        assertTrue(deduplicator.shouldCapture(first, 1_000L))
        assertFalse(deduplicator.shouldCapture(first, 2_000L))
        assertTrue(deduplicator.shouldCapture(changed, 2_000L))
        assertTrue(deduplicator.shouldCapture(removed, 2_000L))
        assertTrue(deduplicator.shouldCapture(first, 8_000L))
    }

    @Test
    fun removalIsCapturedOnlyForAPreviouslyCapturedPostedKey() {
        val gate = NotificationLifecycleGate()
        val posted = event("POSTED", 10, 20)
        val removed = event("REMOVED", 10, 20)
        val unknownRemoval = NotificationEventEntity(
            "unknown",
            "REMOVED",
            "com.example.app",
            2,
            "other-key",
            1_000L,
            1_000L,
            "channel",
            "msg",
            null,
            null,
            true,
            true,
            10,
            20,
            1,
            "METADATA_ONLY"
        )

        assertFalse(gate.shouldCaptureRemoved(unknownRemoval, 1_000L))
        assertTrue(gate.shouldCapturePosted(posted, 1_000L))
        assertTrue(gate.shouldCaptureRemoved(removed, 2_000L))
        assertFalse(gate.shouldCaptureRemoved(removed, 3_000L))
    }

    private fun event(
        type: String,
        titleLength: Int,
        textLength: Int
    ) = NotificationEventEntity(
        "event",
        type,
        "com.example.app",
        1,
        "key-hash",
        1_000L,
        1_000L,
        "channel",
        "msg",
        if (titleLength > 0) "T".repeat(titleLength) else null,
        if (textLength > 0) "B".repeat(textLength) else null,
        titleLength > 0,
        textLength > 0,
        titleLength,
        textLength,
        null,
        "METADATA_ONLY"
    )
}
