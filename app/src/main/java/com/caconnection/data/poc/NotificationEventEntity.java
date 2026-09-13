package com.caconnection.data.poc;

import androidx.annotation.NonNull;
import androidx.room.Entity;
import androidx.room.PrimaryKey;

/**
 * Metadata-only notification observation.
 *
 * Raw title, body, subtext, actions, and notification extras are deliberately
 * not persisted. This lets the POC prove that a listener callback happened
 * without creating another store of OTP or private notification content.
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
    public boolean titleExposed;
    public boolean textExposed;
    public int titleLength;
    public int textLength;
    public Integer removalReason;

    @NonNull
    public String redactionPolicy; // METADATA_ONLY

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
        this.titleExposed = titleExposed;
        this.textExposed = textExposed;
        this.titleLength = titleLength;
        this.textLength = textLength;
        this.removalReason = removalReason;
        this.redactionPolicy = redactionPolicy;
    }
}
