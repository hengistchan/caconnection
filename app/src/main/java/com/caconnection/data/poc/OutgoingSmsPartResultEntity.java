package com.caconnection.data.poc;

import androidx.annotation.NonNull;
import androidx.room.Entity;
import androidx.room.ForeignKey;
import androidx.room.Index;

@Entity(
        tableName = "outgoing_sms_part_results",
        primaryKeys = {"eventId", "partIndex", "callbackType"},
        foreignKeys = @ForeignKey(
                entity = OutgoingSmsEventEntity.class,
                parentColumns = "eventId",
                childColumns = "eventId",
                onDelete = ForeignKey.CASCADE
        ),
        indices = {@Index("eventId")}
)
public class OutgoingSmsPartResultEntity {
    @NonNull
    public String eventId;
    public int partIndex;
    @NonNull
    public String callbackType;
    public int resultCode;
    public long observedAt;

    public OutgoingSmsPartResultEntity(
            @NonNull String eventId,
            int partIndex,
            @NonNull String callbackType,
            int resultCode,
            long observedAt
    ) {
        this.eventId = eventId;
        this.partIndex = partIndex;
        this.callbackType = callbackType;
        this.resultCode = resultCode;
        this.observedAt = observedAt;
    }
}
