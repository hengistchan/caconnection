package com.caconnection.data.poc;

import androidx.annotation.NonNull;
import androidx.room.Entity;
import androidx.room.PrimaryKey;

@Entity(tableName = "outgoing_sms_events")
public class OutgoingSmsEventEntity {
    @PrimaryKey
    @NonNull
    public String eventId;
    public String recipient;
    public String body;
    public long createdAt;
    public long updatedAt;
    public int requestedSubscriptionId;
    public int requestedSlotIndex;
    public String requestedCarrierName;
    public String status;
    public int partCount;
    public int sentPartCount;
    public int deliveredPartCount;
    public int failedPartCount;
    public Integer lastResultCode;
    public String errorDetail;
    public String providerWriteStatus;
    public String providerUri;
    public String providerWriteError;

    public OutgoingSmsEventEntity(
            @NonNull String eventId,
            String recipient,
            String body,
            long createdAt,
            long updatedAt,
            int requestedSubscriptionId,
            int requestedSlotIndex,
            String requestedCarrierName,
            String status,
            int partCount,
            int sentPartCount,
            int deliveredPartCount,
            int failedPartCount,
            Integer lastResultCode,
            String errorDetail,
            String providerWriteStatus,
            String providerUri,
            String providerWriteError
    ) {
        this.eventId = eventId;
        this.recipient = recipient;
        this.body = body;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
        this.requestedSubscriptionId = requestedSubscriptionId;
        this.requestedSlotIndex = requestedSlotIndex;
        this.requestedCarrierName = requestedCarrierName;
        this.status = status;
        this.partCount = partCount;
        this.sentPartCount = sentPartCount;
        this.deliveredPartCount = deliveredPartCount;
        this.failedPartCount = failedPartCount;
        this.lastResultCode = lastResultCode;
        this.errorDetail = errorDetail;
        this.providerWriteStatus = providerWriteStatus;
        this.providerUri = providerUri;
        this.providerWriteError = providerWriteError;
    }
}
