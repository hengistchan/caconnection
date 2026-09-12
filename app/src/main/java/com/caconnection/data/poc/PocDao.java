package com.caconnection.data.poc;

import androidx.room.Dao;
import androidx.room.Insert;
import androidx.room.OnConflictStrategy;
import androidx.room.Query;
import androidx.room.Update;

import java.util.List;

@Dao
public interface PocDao {
    @Query("DELETE FROM subscription_snapshots")
    void clearSubscriptions();

    @Insert
    void insertSubscriptions(List<SubscriptionSnapshotEntity> snapshots);

    @Query("SELECT * FROM subscription_snapshots ORDER BY slotIndex ASC")
    List<SubscriptionSnapshotEntity> getSubscriptions();

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    void insertIncoming(IncomingSmsEventEntity event);

    @Query("SELECT * FROM incoming_sms_events ORDER BY persistedAt DESC LIMIT :limit")
    List<IncomingSmsEventEntity> getLatestIncoming(int limit);

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    void insertOutgoing(OutgoingSmsEventEntity event);

    @Update
    void updateOutgoing(OutgoingSmsEventEntity event);

    @Query("SELECT * FROM outgoing_sms_events WHERE eventId = :eventId LIMIT 1")
    OutgoingSmsEventEntity findOutgoing(String eventId);

    @Query("SELECT * FROM outgoing_sms_events ORDER BY createdAt DESC LIMIT :limit")
    List<OutgoingSmsEventEntity> getLatestOutgoing(int limit);

    @Query("DELETE FROM incoming_sms_events")
    void clearIncoming();

    @Query("DELETE FROM outgoing_sms_events")
    void clearOutgoing();
}
