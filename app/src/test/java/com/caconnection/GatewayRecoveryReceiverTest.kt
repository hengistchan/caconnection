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
    fun rejectsUnrelatedOrMissingActions() {
        assertFalse(GatewayRecoveryReceiver.shouldRecover(Intent.ACTION_TIME_CHANGED))
        assertFalse(GatewayRecoveryReceiver.shouldRecover(null))
    }
}
