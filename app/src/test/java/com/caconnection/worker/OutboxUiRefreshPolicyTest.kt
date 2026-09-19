package com.caconnection.worker

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OutboxUiRefreshPolicyTest {
    @Test
    fun `does not notify when the worker made no durable changes`() {
        assertFalse(
            OutboxUiRefreshPolicy.shouldNotify(
                recoveredStale = 0,
                recoveredLegacy = 0,
                processed = 0
            )
        )
    }

    @Test
    fun `notifies after processing an outbox row`() {
        assertTrue(
            OutboxUiRefreshPolicy.shouldNotify(
                recoveredStale = 0,
                recoveredLegacy = 0,
                processed = 1
            )
        )
    }

    @Test
    fun `notifies after recovering stale or legacy rows`() {
        assertTrue(
            OutboxUiRefreshPolicy.shouldNotify(
                recoveredStale = 1,
                recoveredLegacy = 0,
                processed = 0
            )
        )
        assertTrue(
            OutboxUiRefreshPolicy.shouldNotify(
                recoveredStale = 0,
                recoveredLegacy = 1,
                processed = 0
            )
        )
    }
}
