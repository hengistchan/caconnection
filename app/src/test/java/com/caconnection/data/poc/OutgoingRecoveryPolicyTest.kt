package com.caconnection.data.poc

import org.junit.Assert.assertEquals
import org.junit.Test

class OutgoingRecoveryPolicyTest {
    @Test
    fun dispatchingTimeoutRemainsProvisionalForLateCallbacks() {
        assertEquals(
            "SMS dispatch outcome unknown after process interruption; awaiting late callback",
            OutgoingRecoveryPolicy.dispatchOutcomeUnknown()
        )
    }

    @Test
    fun multipartFailureReportsThatSomePartsMayHaveBeenSent() {
        val event = OutgoingSmsEventEntity(
            "event",
            "10086",
            "body",
            1L,
            1L,
            1,
            0,
            "carrier",
            "remote-command",
            OutgoingStatus.FAILED.name,
            3,
            2,
            0,
            1,
            1,
            "No service",
            "PENDING",
            null,
            null
        )

        assertEquals(
            "Partial SMS failure: 2/3 parts accepted; No service",
            OutgoingStatusDetails.multipartFailure(event)
        )
    }
}
