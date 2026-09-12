package com.caconnection.data.poc;

import android.content.Context;

import androidx.room.Database;
import androidx.room.Room;
import androidx.room.RoomDatabase;
import androidx.room.migration.Migration;
import androidx.sqlite.db.SupportSQLiteDatabase;

@Database(
        entities = {
                SubscriptionSnapshotEntity.class,
                IncomingSmsEventEntity.class,
                OutgoingSmsEventEntity.class,
                OutboxEventEntity.class
        },
        version = 2,
        exportSchema = true
)
public abstract class PocDatabase extends RoomDatabase {
    private static volatile PocDatabase instance;
    
    static final Migration MIGRATION_1_2 = new Migration(1, 2) {
        @Override
        public void migrate(SupportSQLiteDatabase database) {
            // Create outbox_events table
            database.execSQL(
                "CREATE TABLE IF NOT EXISTS `outbox_events` (" +
                "`eventId` TEXT NOT NULL, " +
                "`idempotencyKey` TEXT NOT NULL, " +
                "`incomingEventId` TEXT NOT NULL, " +
                "`status` TEXT NOT NULL, " +
                "`retryCount` INTEGER NOT NULL, " +
                "`nextRetryAt` INTEGER NOT NULL, " +
                "`createdAt` INTEGER NOT NULL, " +
                "`updatedAt` INTEGER NOT NULL, " +
                "`subscriptionId` INTEGER, " +
                "`slotIndex` INTEGER, " +
                "`payloadType` TEXT, " +
                "`payloadData` TEXT, " +
                "`lastError` TEXT, " +
                "`lastResultCode` INTEGER, " +
                "PRIMARY KEY(`eventId`))"
            );
            
            // Create unique index on idempotencyKey
            database.execSQL(
                "CREATE UNIQUE INDEX IF NOT EXISTS `index_outbox_events_idempotencyKey` " +
                "ON `outbox_events` (`idempotencyKey`)"
            );
        }
    };

    public abstract PocDao pocDao();

    public static PocDatabase get(Context context) {
        if (instance == null) {
            synchronized (PocDatabase.class) {
                if (instance == null) {
                    instance = Room.databaseBuilder(
                                    context.getApplicationContext(),
                                    PocDatabase.class,
                                    "gateway-poc.db"
                            )
                            .addMigrations(MIGRATION_1_2)
                            .build();
                }
            }
        }
        return instance;
    }
}
