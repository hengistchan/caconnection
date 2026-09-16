package com.caconnection.notifications

import android.app.Notification
import android.service.notification.StatusBarNotification
import com.caconnection.data.poc.NotificationEventEntity
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.UUID

data class NotificationContent(
    val title: String?,
    val body: String?,
    val titleExposed: Boolean,
    val textExposed: Boolean,
    val titleLength: Int,
    val textLength: Int
)

object NotificationEventFactory {
    const val REDACTION_POLICY = "ALLOWLIST_CONTENT"

    fun content(title: CharSequence?, text: CharSequence?): NotificationContent {
        val safeTitle = title?.toString()?.takeIf { it.isNotBlank() }
        val safeText = text?.toString()?.takeIf { it.isNotBlank() }
        return NotificationContent(
            title = safeTitle,
            body = safeText,
            titleExposed = safeTitle != null,
            textExposed = safeText != null,
            titleLength = safeTitle?.length ?: 0,
            textLength = safeText?.length ?: 0
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
        val content = content(title, text)
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
            content.title,
            content.body,
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
