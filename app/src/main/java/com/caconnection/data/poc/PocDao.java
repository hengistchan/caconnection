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

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    long insertOutgoingPartResult(OutgoingSmsPartResultEntity result);

    @Query("SELECT * FROM outgoing_sms_events WHERE eventId = :eventId LIMIT 1")
    OutgoingSmsEventEntity findOutgoing(String eventId);

    @Query("SELECT * FROM outgoing_sms_events ORDER BY createdAt DESC LIMIT :limit")
    List<OutgoingSmsEventEntity> getLatestOutgoing(int limit);

    @Query("DELETE FROM incoming_sms_events")
    void clearIncoming();

    @Query("DELETE FROM outgoing_sms_events")
    void clearOutgoing();

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    void insertNotification(NotificationEventEntity event);

    @Query("SELECT * FROM notification_events ORDER BY observedAt DESC LIMIT :limit")
    List<NotificationEventEntity> getLatestNotifications(int limit);

    @Query("DELETE FROM notification_events")
    void clearNotifications();

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    void insertCall(CallEventEntity event);

    @Query("SELECT * FROM call_events ORDER BY observedAt DESC LIMIT :limit")
    List<CallEventEntity> getLatestCalls(int limit);

    @Query("DELETE FROM call_events")
    void clearCalls();

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    void insertCallIdentity(CallIdentityEventEntity event);

    @Query("SELECT * FROM call_identity_events ORDER BY observedAt DESC LIMIT :limit")
    List<CallIdentityEventEntity> getLatestCallIdentities(int limit);

    @Query("DELETE FROM call_identity_events")
    void clearCallIdentities();

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    void insertOutbox(OutboxEventEntity event);

    @Update
    void updateOutbox(OutboxEventEntity event);

    @Query("SELECT * FROM outbox_events WHERE status IN ('PENDING', 'RETRY') AND nextRetryAt <= :currentTime ORDER BY nextRetryAt ASC, createdAt ASC LIMIT :limit")
    List<OutboxEventEntity> getReadyOutboxEvents(long currentTime, int limit);

    @Query("UPDATE outbox_events SET status = 'IN_PROGRESS', updatedAt = :now WHERE eventId = :eventId AND status IN ('PENDING', 'RETRY') AND nextRetryAt <= :now")
    int claimReadyOutbox(String eventId, long now);

    @Query("SELECT * FROM outbox_events WHERE eventId = :eventId LIMIT 1")
    OutboxEventEntity findOutbox(String eventId);

    @Query("SELECT * FROM outbox_events WHERE idempotencyKey = :idempotencyKey LIMIT 1")
    OutboxEventEntity findOutboxByIdempotencyKey(String idempotencyKey);

    @Query("SELECT * FROM outbox_events WHERE status = 'PENDING' OR status = 'RETRY'")
    List<OutboxEventEntity> getAllPendingOutboxEvents();

    @Query("SELECT * FROM outbox_events ORDER BY createdAt DESC LIMIT :limit")
    List<OutboxEventEntity> getLatestOutboxEvents(int limit);

    @Query("SELECT MIN(nextRetryAt) FROM outbox_events WHERE status IN ('PENDING', 'RETRY')")
    Long getEarliestScheduledOutboxAt();

    @Query("UPDATE outbox_events SET status = 'RETRY', nextRetryAt = :now, updatedAt = :now, lastError = 'Recovered interrupted delivery attempt' WHERE status = 'IN_PROGRESS' AND updatedAt <= :staleBefore")
    int recoverStaleInProgress(long staleBefore, long now);

    @Query("UPDATE outbox_events SET status = 'RETRY', nextRetryAt = :now, updatedAt = :now, lastError = 'Recovered legacy retry exhaustion' WHERE status = 'FAILED' AND lastError LIKE 'Exceeded maximum retry count (%'")
    int recoverLegacyRetryExhaustion(long now);

    @Query("DELETE FROM outbox_events WHERE status = 'SUCCESS'")
    void clearSuccessfulOutboxEvents();

    @Query("DELETE FROM outbox_events")
    void clearOutbox();
}
