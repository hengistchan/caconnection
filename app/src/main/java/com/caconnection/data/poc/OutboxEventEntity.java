package com.caconnection.data.poc;

import androidx.annotation.NonNull;
import androidx.room.Entity;
import androidx.room.Index;
import androidx.room.PrimaryKey;

@Entity(tableName = "outbox_events", indices = {@Index(value = {"idempotencyKey"}, unique = true)})
public class OutboxEventEntity {
    @PrimaryKey
    @NonNull
    public String eventId;

    @NonNull
    public String idempotencyKey;

    @NonNull
    public String incomingEventId;

    @NonNull
    public String status; // PENDING, IN_PROGRESS, SUCCESS, RETRY, FAILED

    public int retryCount;
    public long nextRetryAt;
    public long createdAt;
    public long updatedAt;

    public Integer subscriptionId;
    public Integer slotIndex;

    public String payloadType; // INCOMING_SMS
    public String payloadData; // JSON serialized payload

    public String lastError;
    public Integer lastResultCode;

    public OutboxEventEntity(
            @NonNull String eventId,
            @NonNull String idempotencyKey,
            @NonNull String incomingEventId,
            @NonNull String status,
            int retryCount,
            long nextRetryAt,
            long createdAt,
            long updatedAt,
            Integer subscriptionId,
            Integer slotIndex,
            String payloadType,
            String payloadData,
            String lastError,
            Integer lastResultCode
    ) {
        this.eventId = eventId;
        this.idempotencyKey = idempotencyKey;
        this.incomingEventId = incomingEventId;
        this.status = status;
        this.retryCount = retryCount;
        this.nextRetryAt = nextRetryAt;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
        this.subscriptionId = subscriptionId;
        this.slotIndex = slotIndex;
        this.payloadType = payloadType;
        this.payloadData = payloadData;
        this.lastError = lastError;
        this.lastResultCode = lastResultCode;
    }
}
