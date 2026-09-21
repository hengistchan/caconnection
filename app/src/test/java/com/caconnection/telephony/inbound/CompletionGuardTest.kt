package com.caconnection.telephony.inbound

import org.junit.Assert.assertEquals
import org.junit.Test

class CompletionGuardTest {
    @Test
    fun completesOnlyOnceAcrossCompetingFailurePaths() {
        var completions = 0
        val guard = CompletionGuard { completions += 1 }

        guard.finish()
        guard.finish()
        guard.finish()

        assertEquals(1, completions)
    }
}
