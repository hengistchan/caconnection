package com.caconnection.data.poc;

import android.content.Context;

import androidx.room.Database;
import androidx.room.Room;
import androidx.room.RoomDatabase;

@Database(
        entities = {
                SubscriptionSnapshotEntity.class,
                IncomingSmsEventEntity.class,
                OutgoingSmsEventEntity.class
        },
        version = 1,
        exportSchema = true
)
public abstract class PocDatabase extends RoomDatabase {
    private static volatile PocDatabase instance;

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
                            .build();
                }
            }
        }
        return instance;
    }
}
