package com.caconnection.telephony.diagnostics

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayReadinessEvaluatorTest {
    private val readyInput = GatewayReadinessInput(
        targetSdk = 37,
        applicationId = "com.caconnection.debug",
        defaultSmsPackage = "com.android.mms",
        smsRoleHeld = false,
        receiveSmsGranted = true,
        sendSmsGranted = true,
        readPhoneStateGranted = true,
        subscriptions = listOf(
            ReadinessSubscription(subscriptionId = 1, slotIndex = 0),
            ReadinessSubscription(subscriptionId = 2, slotIndex = 1)
        )
    )

    @Test
    fun readyWhenAllLocallyObservablePathARequirementsPass() {
        val result = GatewayReadinessEvaluator.evaluate(readyInput)

        assertTrue(result.localReady)
        assertTrue(result.checks.all { it.passed })
    }

    @Test
    fun notReadyWhenOnlyOneSimIsVisible() {
        val result = GatewayReadinessEvaluator.evaluate(
            readyInput.copy(subscriptions = readyInput.subscriptions.take(1))
        )

        assertFalse(result.localReady)
        assertFalse(result.checks.first { it.label == "Two distinct active SIMs" }.passed)
    }

    @Test
    fun notReadyWhenGatewayUnexpectedlyHoldsDefaultSmsRole() {
        val result = GatewayReadinessEvaluator.evaluate(
            readyInput.copy(
                defaultSmsPackage = readyInput.applicationId,
                smsRoleHeld = true
            )
        )

        assertFalse(result.localReady)
        assertFalse(result.checks.first { it.label.contains("default SMS role") }.passed)
    }

    @Test
    fun readyWhenDefaultPackageNameIsHiddenButGatewayRoleIsNotHeld() {
        val result = GatewayReadinessEvaluator.evaluate(
            readyInput.copy(defaultSmsPackage = null)
        )

        assertTrue(result.localReady)
        assertTrue(result.checks.first { it.label.contains("default SMS role") }.passed)
    }

    @Test
    fun notReadyWhenTargetSdkOrPermissionIsWrong() {
        val result = GatewayReadinessEvaluator.evaluate(
            readyInput.copy(targetSdk = 36, receiveSmsGranted = false)
        )

        assertFalse(result.localReady)
        assertFalse(result.checks.first { it.label == "targetSdk 37" }.passed)
        assertFalse(result.checks.first { it.label == "RECEIVE_SMS" }.passed)
    }
}
