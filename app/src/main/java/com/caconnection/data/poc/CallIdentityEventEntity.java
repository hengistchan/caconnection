package com.caconnection.data.poc;

import androidx.annotation.NonNull;
import androidx.room.Entity;
import androidx.room.PrimaryKey;

/**
 * Incoming-call identity observed by CallScreeningService.
 *
 * callerAddress and callerDisplayName are sensitive local POC data. They are
 * never written to logs or engineering reports.
 */
@Entity(tableName = "call_identity_events")
public class CallIdentityEventEntity {
    @PrimaryKey
    @NonNull
    public String eventId;

    public String telecomCallIdHash;
    public String callerAddress;
    public String callerDisplayName;
    public int handlePresentation;
    public int displayNamePresentation;
    public String phoneAccountId;
    public Integer resolvedSubscriptionId;
    public Integer resolvedSlotIndex;
    public String resolutionMethod;
    public String resolutionConfidence;
    public String resolutionNotes;
    public int verificationStatus;
    public long observedAt;
    public long respondedAt;

    @NonNull
    public String decision; // ALLOW

    public CallIdentityEventEntity(
            @NonNull String eventId,
            String telecomCallIdHash,
            String callerAddress,
            String callerDisplayName,
            int handlePresentation,
            int displayNamePresentation,
            String phoneAccountId,
            Integer resolvedSubscriptionId,
            Integer resolvedSlotIndex,
            String resolutionMethod,
            String resolutionConfidence,
            String resolutionNotes,
            int verificationStatus,
            long observedAt,
            long respondedAt,
            @NonNull String decision
    ) {
        this.eventId = eventId;
        this.telecomCallIdHash = telecomCallIdHash;
        this.callerAddress = callerAddress;
        this.callerDisplayName = callerDisplayName;
        this.handlePresentation = handlePresentation;
        this.displayNamePresentation = displayNamePresentation;
        this.phoneAccountId = phoneAccountId;
        this.resolvedSubscriptionId = resolvedSubscriptionId;
        this.resolvedSlotIndex = resolvedSlotIndex;
        this.resolutionMethod = resolutionMethod;
        this.resolutionConfidence = resolutionConfidence;
        this.resolutionNotes = resolutionNotes;
        this.verificationStatus = verificationStatus;
        this.observedAt = observedAt;
        this.respondedAt = respondedAt;
        this.decision = decision;
    }
}
