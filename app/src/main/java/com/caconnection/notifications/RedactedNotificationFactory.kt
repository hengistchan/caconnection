package com.caconnection.notifications

import android.app.Notification
import android.service.notification.StatusBarNotification
import com.caconnection.data.poc.NotificationEventEntity
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.UUID

data class RedactedContentMetadata(
    val titleExposed: Boolean,
    val textExposed: Boolean,
    val titleLength: Int,
    val textLength: Int
)

object RedactedNotificationFactory {
    const val REDACTION_POLICY = "METADATA_ONLY"

    fun contentMetadata(title: CharSequence?, text: CharSequence?): RedactedContentMetadata {
        val safeTitle = title?.toString().orEmpty()
        val safeText = text?.toString().orEmpty()
        return RedactedContentMetadata(
            titleExposed = safeTitle.isNotEmpty(),
            textExposed = safeText.isNotEmpty(),
            titleLength = safeTitle.length,
            textLength = safeText.length
        )
    }

    fun create(
        sbn: StatusBarNotification,
        eventType: String,
        removalReason: Int? = null,
        observedAt: Long = System.currentTimeMillis()
    ): NotificationEventEntity {
        val extras = sbn.notification.extras
        val title = extras?.getCharSequence(Notification.EXTRA_TITLE)
        val text = extras?.getCharSequence(Notification.EXTRA_BIG_TEXT)
            ?: extras?.getCharSequence(Notification.EXTRA_TEXT)
        val content = contentMetadata(title, text)
        return NotificationEventEntity(
            UUID.randomUUID().toString(),
            eventType,
            sbn.packageName,
            sbn.id,
            sha256(sbn.key.orEmpty()),
            sbn.postTime,
            observedAt,
            sbn.notification.channelId,
            sbn.notification.category,
            content.titleExposed,
            content.textExposed,
            content.titleLength,
            content.textLength,
            removalReason,
            REDACTION_POLICY
        )
    }

    private fun sha256(value: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(StandardCharsets.UTF_8))
            .joinToString(separator = "") { byte -> "%02x".format(byte) }
}
