package com.caconnection.data.poc;

import androidx.annotation.NonNull;
import androidx.room.Entity;
import androidx.room.Index;
import androidx.room.PrimaryKey;

@Entity(tableName = "incoming_sms_events", indices = {@Index(value = {"persistedAt"})})
public class IncomingSmsEventEntity {
    @PrimaryKey
    @NonNull
    public String eventId;
    public String action;
    public String originatingAddress;
    public String body;
    public long receivedAt;
    public long persistedAt;
    public int partCount;
    public Integer resolvedSubscriptionId;
    public Integer resolvedSlotIndex;
    public String resolutionMethod;
    public String resolutionConfidence;
    public String resolutionNotes;
    public String rawExtras;
    public String providerWriteStatus;
    public String providerUri;
    public String providerWriteError;

    public IncomingSmsEventEntity(
            @NonNull String eventId,
            String action,
            String originatingAddress,
            String body,
            long receivedAt,
            long persistedAt,
            int partCount,
            Integer resolvedSubscriptionId,
            Integer resolvedSlotIndex,
            String resolutionMethod,
            String resolutionConfidence,
            String resolutionNotes,
            String rawExtras,
            String providerWriteStatus,
            String providerUri,
            String providerWriteError
    ) {
        this.eventId = eventId;
        this.action = action;
        this.originatingAddress = originatingAddress;
        this.body = body;
        this.receivedAt = receivedAt;
        this.persistedAt = persistedAt;
        this.partCount = partCount;
        this.resolvedSubscriptionId = resolvedSubscriptionId;
        this.resolvedSlotIndex = resolvedSlotIndex;
        this.resolutionMethod = resolutionMethod;
        this.resolutionConfidence = resolutionConfidence;
        this.resolutionNotes = resolutionNotes;
        this.rawExtras = rawExtras;
        this.providerWriteStatus = providerWriteStatus;
        this.providerUri = providerUri;
        this.providerWriteError = providerWriteError;
    }
}
