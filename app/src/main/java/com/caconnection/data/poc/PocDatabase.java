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
                OutgoingSmsPartResultEntity.class,
                NotificationEventEntity.class,
                CallEventEntity.class,
                CallIdentityEventEntity.class,
                OutboxEventEntity.class
        },
        version = 7,
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

    static final Migration MIGRATION_2_3 = new Migration(2, 3) {
        @Override
        public void migrate(SupportSQLiteDatabase database) {
            database.execSQL(
                "CREATE TABLE IF NOT EXISTS `notification_events` (" +
                "`eventId` TEXT NOT NULL, " +
                "`eventType` TEXT NOT NULL, " +
                "`sourcePackage` TEXT NOT NULL, " +
                "`notificationId` INTEGER NOT NULL, " +
                "`notificationKeyHash` TEXT, " +
                "`postedAt` INTEGER NOT NULL, " +
                "`observedAt` INTEGER NOT NULL, " +
                "`channelId` TEXT, " +
                "`category` TEXT, " +
                "`titleExposed` INTEGER NOT NULL, " +
                "`textExposed` INTEGER NOT NULL, " +
                "`titleLength` INTEGER NOT NULL, " +
                "`textLength` INTEGER NOT NULL, " +
                "`removalReason` INTEGER, " +
                "`redactionPolicy` TEXT NOT NULL, " +
                "PRIMARY KEY(`eventId`))"
            );
            database.execSQL(
                "CREATE TABLE IF NOT EXISTS `call_events` (" +
                "`eventId` TEXT NOT NULL, " +
                "`sessionId` TEXT NOT NULL, " +
                "`subscriptionId` INTEGER NOT NULL, " +
                "`slotIndex` INTEGER NOT NULL, " +
                "`state` TEXT NOT NULL, " +
                "`observedAt` INTEGER NOT NULL, " +
                "`initialSnapshot` INTEGER NOT NULL, " +
                "PRIMARY KEY(`eventId`))"
            );
        }
    };

    static final Migration MIGRATION_3_4 = new Migration(3, 4) {
        @Override
        public void migrate(SupportSQLiteDatabase database) {
            database.execSQL(
                "CREATE TABLE IF NOT EXISTS `call_identity_events` (" +
                "`eventId` TEXT NOT NULL, " +
                "`telecomCallIdHash` TEXT, " +
                "`callerAddress` TEXT, " +
                "`callerDisplayName` TEXT, " +
                "`handlePresentation` INTEGER NOT NULL, " +
                "`displayNamePresentation` INTEGER NOT NULL, " +
                "`phoneAccountId` TEXT, " +
                "`resolvedSubscriptionId` INTEGER, " +
                "`resolvedSlotIndex` INTEGER, " +
                "`resolutionMethod` TEXT, " +
                "`resolutionConfidence` TEXT, " +
                "`resolutionNotes` TEXT, " +
                "`verificationStatus` INTEGER NOT NULL, " +
                "`observedAt` INTEGER NOT NULL, " +
                "`respondedAt` INTEGER NOT NULL, " +
                "`decision` TEXT NOT NULL, " +
                "PRIMARY KEY(`eventId`))"
            );
        }
    };

    static final Migration MIGRATION_4_5 = new Migration(4, 5) {
        @Override
        public void migrate(SupportSQLiteDatabase database) {
            database.execSQL(
                "ALTER TABLE `notification_events` ADD COLUMN `title` TEXT"
            );
            database.execSQL(
                "ALTER TABLE `notification_events` ADD COLUMN `body` TEXT"
            );
        }
    };

    static final Migration MIGRATION_5_6 = new Migration(5, 6) {
        @Override
        public void migrate(SupportSQLiteDatabase database) {
            database.execSQL(
                "ALTER TABLE `outgoing_sms_events` " +
                "ADD COLUMN `remoteCommandId` TEXT"
            );
        }
    };

    static final Migration MIGRATION_6_7 = new Migration(6, 7) {
        @Override
        public void migrate(SupportSQLiteDatabase database) {
            database.execSQL(
                "CREATE TABLE IF NOT EXISTS `outgoing_sms_part_results` (" +
                "`eventId` TEXT NOT NULL, " +
                "`partIndex` INTEGER NOT NULL, " +
                "`callbackType` TEXT NOT NULL, " +
                "`resultCode` INTEGER NOT NULL, " +
                "`observedAt` INTEGER NOT NULL, " +
                "PRIMARY KEY(`eventId`, `partIndex`, `callbackType`), " +
                "FOREIGN KEY(`eventId`) REFERENCES `outgoing_sms_events`(`eventId`) " +
                "ON UPDATE NO ACTION ON DELETE CASCADE)"
            );
            database.execSQL(
                "CREATE INDEX IF NOT EXISTS `index_outgoing_sms_part_results_eventId` " +
                "ON `outgoing_sms_part_results` (`eventId`)"
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
                            .addMigrations(
                                    MIGRATION_1_2,
                                    MIGRATION_2_3,
                                    MIGRATION_3_4,
                                    MIGRATION_4_5,
                                    MIGRATION_5_6,
                                    MIGRATION_6_7
                            )
                            .build();
                }
            }
        }
        return instance;
    }
}
