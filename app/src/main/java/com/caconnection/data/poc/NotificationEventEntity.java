package com.caconnection.data.poc;

import androidx.annotation.NonNull;
import androidx.room.Entity;
import androidx.room.PrimaryKey;

/**
 * Notification observation captured from an explicitly allowlisted app.
 *
 * The user-visible title and body are persisted so they can be delivered to
 * the Gateway API and Admin UI. Actions and arbitrary notification extras are
 * still excluded.
 */
@Entity(tableName = "notification_events")
public class NotificationEventEntity {
    @PrimaryKey
    @NonNull
    public String eventId;

    @NonNull
    public String eventType; // POSTED or REMOVED

    @NonNull
    public String sourcePackage;

    public int notificationId;
    public String notificationKeyHash;
    public long postedAt;
    public long observedAt;
    public String channelId;
    public String category;
    public String title;
    public String body;
    public boolean titleExposed;
    public boolean textExposed;
    public int titleLength;
    public int textLength;
    public Integer removalReason;

    @NonNull
    public String redactionPolicy; // Legacy field; current value is ALLOWLIST_CONTENT

    public NotificationEventEntity(
            @NonNull String eventId,
            @NonNull String eventType,
            @NonNull String sourcePackage,
            int notificationId,
            String notificationKeyHash,
            long postedAt,
            long observedAt,
            String channelId,
            String category,
            String title,
            String body,
            boolean titleExposed,
            boolean textExposed,
            int titleLength,
            int textLength,
            Integer removalReason,
            @NonNull String redactionPolicy
    ) {
        this.eventId = eventId;
        this.eventType = eventType;
        this.sourcePackage = sourcePackage;
        this.notificationId = notificationId;
        this.notificationKeyHash = notificationKeyHash;
        this.postedAt = postedAt;
        this.observedAt = observedAt;
        this.channelId = channelId;
        this.category = category;
        this.title = title;
        this.body = body;
        this.titleExposed = titleExposed;
        this.textExposed = textExposed;
        this.titleLength = titleLength;
        this.textLength = textLength;
        this.removalReason = removalReason;
        this.redactionPolicy = redactionPolicy;
    }
}
