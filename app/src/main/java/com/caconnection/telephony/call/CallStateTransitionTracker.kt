package com.caconnection.telephony.call

import android.telephony.TelephonyManager
import java.util.UUID

data class CallStateObservation(
    val sessionId: String,
    val subscriptionId: Int,
    val slotIndex: Int,
    val state: String,
    val observedAt: Long,
    val initialSnapshot: Boolean
)

class CallStateTransitionTracker(
    private val sessionIdFactory: () -> String = { UUID.randomUUID().toString() }
) {
    private val lastStateBySubscription = mutableMapOf<Int, Int>()
    private val sessionBySubscription = mutableMapOf<Int, String>()

    @Synchronized
    fun accept(
        subscriptionId: Int,
        slotIndex: Int,
        state: Int,
        observedAt: Long
    ): CallStateObservation? {
        if (state !in VALID_STATES) return null

        val previous = lastStateBySubscription.put(subscriptionId, state)
        if (previous == state) return null
        if (previous == null && state == TelephonyManager.CALL_STATE_IDLE) return null

        val sessionId = when {
            previous == null || previous == TelephonyManager.CALL_STATE_IDLE ->
                sessionIdFactory().also { sessionBySubscription[subscriptionId] = it }
            else -> sessionBySubscription[subscriptionId]
                ?: sessionIdFactory().also { sessionBySubscription[subscriptionId] = it }
        }
        val observation = CallStateObservation(
            sessionId = sessionId,
            subscriptionId = subscriptionId,
            slotIndex = slotIndex,
            state = stateName(state),
            observedAt = observedAt,
            initialSnapshot = previous == null
        )
        if (state == TelephonyManager.CALL_STATE_IDLE) {
            sessionBySubscription.remove(subscriptionId)
        }
        return observation
    }

    @Synchronized
    fun removeSubscription(subscriptionId: Int) {
        lastStateBySubscription.remove(subscriptionId)
        sessionBySubscription.remove(subscriptionId)
    }

    companion object {
        private val VALID_STATES = setOf(
            TelephonyManager.CALL_STATE_IDLE,
            TelephonyManager.CALL_STATE_RINGING,
            TelephonyManager.CALL_STATE_OFFHOOK
        )

        fun stateName(state: Int): String = when (state) {
            TelephonyManager.CALL_STATE_RINGING -> "RINGING"
            TelephonyManager.CALL_STATE_OFFHOOK -> "OFFHOOK"
            TelephonyManager.CALL_STATE_IDLE -> "IDLE"
            else -> "UNKNOWN"
        }
    }
}
