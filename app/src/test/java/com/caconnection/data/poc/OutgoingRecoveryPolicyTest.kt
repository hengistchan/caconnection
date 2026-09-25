package com.caconnection.data.poc

import org.junit.Assert.assertEquals
import org.junit.Test

class OutgoingRecoveryPolicyTest {
    @Test
    fun createdFailureExplainsThatDispatchNeverStarted() {
        assertEquals(
            "Interrupted before SMS dispatch; not retried automatically",
            OutgoingRecoveryPolicy.failureDetail(OutgoingStatus.CREATED.name)
        )
    }

    @Test
    fun dispatchingFailureDoesNotClaimThatSmsWasUnsent() {
        assertEquals(
            "SMS dispatch outcome unknown after process interruption; not retried automatically",
            OutgoingRecoveryPolicy.failureDetail(OutgoingStatus.DISPATCHING.name)
        )
    }
}
