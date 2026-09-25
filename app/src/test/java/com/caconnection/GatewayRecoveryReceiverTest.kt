package com.caconnection

import android.content.Intent
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayRecoveryReceiverTest {

    @Test
    fun acceptsBootAndPackageReplacementActions() {
        assertTrue(GatewayRecoveryReceiver.shouldRecover(Intent.ACTION_BOOT_COMPLETED))
        assertTrue(GatewayRecoveryReceiver.shouldRecover(Intent.ACTION_MY_PACKAGE_REPLACED))
    }

    @Test
    fun acceptsUserPresentForPostKillRecovery() {
        assertTrue(GatewayRecoveryReceiver.shouldRecover(Intent.ACTION_USER_PRESENT))
    }

    /**
     * PACKAGE_RESTARTED is a force-stop notification, not a wake-up event: the
     * killed package is in the stopped state and cannot recover from it.
     */
    @Test
    fun rejectsPackageRestartedAndUnrelatedActions() {
        assertFalse(GatewayRecoveryReceiver.shouldRecover(Intent.ACTION_PACKAGE_RESTARTED))
        assertFalse(GatewayRecoveryReceiver.shouldRecover(Intent.ACTION_TIME_CHANGED))
        assertFalse(GatewayRecoveryReceiver.shouldRecover(null))
    }

    @Test
    fun throttlesFrequentUserPresentTriggers() {
        val interval = GatewayRecoveryReceiver.MIN_UNLOCK_RECOVERY_INTERVAL_MS
        // Within the window — throttled.
        assertTrue(
            GatewayRecoveryReceiver.isThrottled(
                Intent.ACTION_USER_PRESENT,
                lastRecoverAt = 1_000L,
                now = 1_000L + interval - 1
            )
        )
        // After the window — allowed.
        assertFalse(
            GatewayRecoveryReceiver.isThrottled(
                Intent.ACTION_USER_PRESENT,
                lastRecoverAt = 1_000L,
                now = 1_000L + interval
            )
        )
    }

    @Test
    fun neverThrottlesRareRecoveryActions() {
        assertFalse(
            GatewayRecoveryReceiver.isThrottled(
                Intent.ACTION_BOOT_COMPLETED,
                lastRecoverAt = 1_000L,
                now = 1_001L
            )
        )
    }
}
