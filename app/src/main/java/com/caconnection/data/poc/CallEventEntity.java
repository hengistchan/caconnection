package com.caconnection.data.poc;

import androidx.annotation.NonNull;
import androidx.room.Entity;
import androidx.room.PrimaryKey;

/**
 * Per-subscription call-state transition. Caller identity is intentionally
 * absent; obtaining it would require a separate call-screening role.
 */
@Entity(tableName = "call_events")
public class CallEventEntity {
    @PrimaryKey
    @NonNull
    public String eventId;

    @NonNull
    public String sessionId;

    public int subscriptionId;
    public int slotIndex;

    @NonNull
    public String state; // RINGING, OFFHOOK, IDLE

    public long observedAt;
    public boolean initialSnapshot;

    public CallEventEntity(
            @NonNull String eventId,
            @NonNull String sessionId,
            int subscriptionId,
            int slotIndex,
            @NonNull String state,
            long observedAt,
            boolean initialSnapshot
    ) {
        this.eventId = eventId;
        this.sessionId = sessionId;
        this.subscriptionId = subscriptionId;
        this.slotIndex = slotIndex;
        this.state = state;
        this.observedAt = observedAt;
        this.initialSnapshot = initialSnapshot;
    }
}
