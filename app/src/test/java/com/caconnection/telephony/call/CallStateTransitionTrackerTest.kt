package com.caconnection.telephony.call

import android.telephony.TelephonyManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CallStateTransitionTrackerTest {
    @Test
    fun suppressesInitialIdleAndDuplicateStates() {
        val tracker = CallStateTransitionTracker { "session-1" }

        assertNull(tracker.accept(1, 0, TelephonyManager.CALL_STATE_IDLE, 100L))
        val ringing = tracker.accept(1, 0, TelephonyManager.CALL_STATE_RINGING, 200L)
        assertNull(tracker.accept(1, 0, TelephonyManager.CALL_STATE_RINGING, 300L))

        assertEquals("RINGING", ringing?.state)
        assertEquals("session-1", ringing?.sessionId)
        assertFalse(ringing!!.initialSnapshot)
    }

    @Test
    fun keepsOneSessionAcrossRingingOffhookIdle() {
        var nextSession = 0
        val tracker = CallStateTransitionTracker { "session-${++nextSession}" }
        tracker.accept(2, 1, TelephonyManager.CALL_STATE_IDLE, 100L)

        val ringing = tracker.accept(2, 1, TelephonyManager.CALL_STATE_RINGING, 200L)
        val offhook = tracker.accept(2, 1, TelephonyManager.CALL_STATE_OFFHOOK, 300L)
        val idle = tracker.accept(2, 1, TelephonyManager.CALL_STATE_IDLE, 400L)
        val secondRinging =
            tracker.accept(2, 1, TelephonyManager.CALL_STATE_RINGING, 500L)

        assertEquals("session-1", ringing?.sessionId)
        assertEquals("session-1", offhook?.sessionId)
        assertEquals("session-1", idle?.sessionId)
        assertEquals("session-2", secondRinging?.sessionId)
        assertEquals("OFFHOOK", offhook?.state)
        assertEquals("IDLE", idle?.state)
    }

    @Test
    fun initialActiveCallIsCapturedAndAttributedToItsSim() {
        val tracker = CallStateTransitionTracker { "session-active" }

        val event = tracker.accept(
            subscriptionId = 9,
            slotIndex = 1,
            state = TelephonyManager.CALL_STATE_OFFHOOK,
            observedAt = 600L
        )

        assertTrue(event!!.initialSnapshot)
        assertEquals(9, event.subscriptionId)
        assertEquals(1, event.slotIndex)
        assertEquals("OFFHOOK", event.state)
    }

    @Test
    fun subscriptionsKeepIndependentSessions() {
        var nextSession = 0
        val tracker = CallStateTransitionTracker { "session-${++nextSession}" }

        val sim1 = tracker.accept(1, 0, TelephonyManager.CALL_STATE_RINGING, 100L)
        val sim2 = tracker.accept(2, 1, TelephonyManager.CALL_STATE_RINGING, 100L)

        assertEquals(0, sim1?.slotIndex)
        assertEquals(1, sim2?.slotIndex)
        assertTrue(sim1?.sessionId != sim2?.sessionId)
    }
}
