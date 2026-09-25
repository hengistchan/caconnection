package com.caconnection

import android.content.Intent
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayRecoveryReceiverTest {
    private val ownPackage = "com.caconnection.gateway"

    @Test
    fun acceptsBootAndPackageReplacementActions() {
        assertTrue(
            GatewayRecoveryReceiver.shouldRecover(
                Intent.ACTION_BOOT_COMPLETED, null, ownPackage
            )
        )
        assertTrue(
            GatewayRecoveryReceiver.shouldRecover(
                Intent.ACTION_MY_PACKAGE_REPLACED, null, ownPackage
            )
        )
    }

    @Test
    fun acceptsUserPresentForPostKillRecovery() {
        assertTrue(
            GatewayRecoveryReceiver.shouldRecover(
                Intent.ACTION_USER_PRESENT, null, ownPackage
            )
        )
    }

    @Test
    fun packageRestartedOnlyRecoversOwnPackage() {
        assertTrue(
            GatewayRecoveryReceiver.shouldRecover(
                Intent.ACTION_PACKAGE_RESTARTED, ownPackage, ownPackage
            )
        )
        assertFalse(
            GatewayRecoveryReceiver.shouldRecover(
                Intent.ACTION_PACKAGE_RESTARTED, "com.other.app", ownPackage
            )
        )
        assertFalse(
            GatewayRecoveryReceiver.shouldRecover(
                Intent.ACTION_PACKAGE_RESTARTED, null, ownPackage
            )
        )
    }

    @Test
    fun rejectsUnrelatedOrMissingActions() {
        assertFalse(
            GatewayRecoveryReceiver.shouldRecover(
                Intent.ACTION_TIME_CHANGED, null, ownPackage
            )
        )
        assertFalse(GatewayRecoveryReceiver.shouldRecover(null, null, ownPackage))
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
        assertFalse(
            GatewayRecoveryReceiver.isThrottled(
                Intent.ACTION_PACKAGE_RESTARTED,
                lastRecoverAt = 1_000L,
                now = 1_001L
            )
        )
    }
}
