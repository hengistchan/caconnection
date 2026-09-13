package com.caconnection.notifications

import android.app.Notification
import com.caconnection.data.poc.NotificationEventEntity

object NotificationCapturePolicy {
    fun isUserFacing(flags: Int): Boolean =
        flags and Notification.FLAG_FOREGROUND_SERVICE == 0 &&
            flags and Notification.FLAG_GROUP_SUMMARY == 0
}

class NotificationEventDeduplicator(
    private val duplicateWindowMillis: Long = 5_000L
) {
    private val lastSeenByFingerprint = mutableMapOf<String, Long>()

    @Synchronized
    fun shouldCapture(event: NotificationEventEntity, now: Long): Boolean {
        lastSeenByFingerprint.entries.removeAll {
            now - it.value > duplicateWindowMillis
        }
        val fingerprint = listOf(
            event.eventType,
            event.sourcePackage,
            event.notificationKeyHash.orEmpty(),
            event.postedAt.toString(),
            event.titleLength.toString(),
            event.textLength.toString()
        ).joinToString("|")
        val lastSeen = lastSeenByFingerprint[fingerprint]
        lastSeenByFingerprint[fingerprint] = now
        return lastSeen == null || now - lastSeen > duplicateWindowMillis
    }
}

class NotificationLifecycleGate(
    duplicateWindowMillis: Long = 5_000L
) {
    private val deduplicator = NotificationEventDeduplicator(duplicateWindowMillis)
    private val capturedKeys = mutableSetOf<String>()

    @Synchronized
    fun shouldCapturePosted(event: NotificationEventEntity, now: Long): Boolean {
        val key = event.notificationKeyHash ?: return false
        capturedKeys += key
        return deduplicator.shouldCapture(event, now)
    }

    @Synchronized
    fun shouldCaptureRemoved(event: NotificationEventEntity, now: Long): Boolean {
        val key = event.notificationKeyHash ?: return false
        if (!capturedKeys.remove(key)) return false
        return deduplicator.shouldCapture(event, now)
    }
}
