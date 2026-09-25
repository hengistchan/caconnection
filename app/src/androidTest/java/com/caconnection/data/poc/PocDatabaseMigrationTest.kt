package com.caconnection.data.poc

import android.content.Context
import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PocDatabaseMigrationTest {
    @get:Rule
    val helper = MigrationTestHelper(
        InstrumentationRegistry.getInstrumentation(),
        PocDatabase::class.java
    )

    private val context: Context = ApplicationProvider.getApplicationContext()

    @After
    fun cleanUp() {
        context.deleteDatabase(TEST_DATABASE)
    }

    @Test
    fun everyHistoricalSchemaMigratesToLatest() {
        for (sourceVersion in 1..7) {
            context.deleteDatabase(TEST_DATABASE)
            helper.createDatabase(TEST_DATABASE, sourceVersion).close()
            helper.runMigrationsAndValidate(
                TEST_DATABASE,
                8,
                true,
                PocDatabase.MIGRATION_1_2,
                PocDatabase.MIGRATION_2_3,
                PocDatabase.MIGRATION_3_4,
                PocDatabase.MIGRATION_4_5,
                PocDatabase.MIGRATION_5_6,
                PocDatabase.MIGRATION_6_7,
                PocDatabase.MIGRATION_7_8
            ).close()
        }
    }

    @Test
    fun migration6To7PreservesOutgoingRowsAndDeduplicatesPartCallbacks() {
        helper.createDatabase(TEST_DATABASE, 6).apply {
            insertOutgoingEvent(this)
            close()
        }

        val database = Room.databaseBuilder(
            context,
            PocDatabase::class.java,
            TEST_DATABASE
        ).addMigrations(PocDatabase.MIGRATION_6_7)
            .allowMainThreadQueries()
            .build()
        try {
            val writable = database.openHelper.writableDatabase
            writable.query(
                "SELECT status, partCount FROM outgoing_sms_events WHERE eventId = ?",
                arrayOf(EVENT_ID)
            ).use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("DISPATCHING", cursor.getString(0))
                assertEquals(2, cursor.getInt(1))
            }

            val dao = database.pocDao()
            val first = dao.insertOutgoingPartResult(
                OutgoingSmsPartResultEntity(
                    EVENT_ID,
                    0,
                    OutgoingPartCallbackType.SENT.name,
                    -1,
                    1_000L
                )
            )
            val duplicate = dao.insertOutgoingPartResult(
                OutgoingSmsPartResultEntity(
                    EVENT_ID,
                    0,
                    OutgoingPartCallbackType.SENT.name,
                    -1,
                    2_000L
                )
            )
            assertTrue(first >= 0)
            assertEquals(-1L, duplicate)
        } finally {
            database.close()
        }
    }

    private fun insertOutgoingEvent(database: SupportSQLiteDatabase) {
        database.execSQL(
            """
            INSERT INTO outgoing_sms_events(
              eventId, recipient, body, createdAt, updatedAt,
              requestedSubscriptionId, requestedSlotIndex, requestedCarrierName,
              remoteCommandId, status, partCount, sentPartCount,
              deliveredPartCount, failedPartCount, lastResultCode, errorDetail,
              providerWriteStatus, providerUri, providerWriteError
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """.trimIndent(),
            arrayOf<Any?>(
                EVENT_ID,
                "10086",
                "test",
                1_000L,
                1_000L,
                1,
                0,
                "carrier",
                null,
                "DISPATCHING",
                2,
                0,
                0,
                0,
                null,
                null,
                "SYSTEM_MANAGED_NON_DEFAULT",
                null,
                null
            )
        )
    }

    companion object {
        private const val TEST_DATABASE = "poc-migration-test"
        private const val EVENT_ID = "event-multipart"
    }
}
