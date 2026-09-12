package com.caconnection.data.poc;

import androidx.room.Entity;
import androidx.room.PrimaryKey;

@Entity(tableName = "subscription_snapshots")
public class SubscriptionSnapshotEntity {
    @PrimaryKey(autoGenerate = true)
    public long id;
    public long capturedAt;
    public int subscriptionId;
    public int slotIndex;
    public String displayName;
    public String carrierName;
    public String countryIso;
    public boolean embedded;
    public boolean opportunistic;

    public SubscriptionSnapshotEntity(
            long capturedAt,
            int subscriptionId,
            int slotIndex,
            String displayName,
            String carrierName,
            String countryIso,
            boolean embedded,
            boolean opportunistic
    ) {
        this.capturedAt = capturedAt;
        this.subscriptionId = subscriptionId;
        this.slotIndex = slotIndex;
        this.displayName = displayName;
        this.carrierName = carrierName;
        this.countryIso = countryIso;
        this.embedded = embedded;
        this.opportunistic = opportunistic;
    }
}
