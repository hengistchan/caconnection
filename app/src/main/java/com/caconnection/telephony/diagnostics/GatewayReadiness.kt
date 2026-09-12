package com.caconnection.telephony.diagnostics

data class GatewayReadinessInput(
    val targetSdk: Int,
    val applicationId: String,
    val defaultSmsPackage: String?,
    val smsRoleHeld: Boolean,
    val receiveSmsGranted: Boolean,
    val sendSmsGranted: Boolean,
    val readPhoneStateGranted: Boolean,
    val subscriptions: List<ReadinessSubscription>
)

data class ReadinessSubscription(
    val subscriptionId: Int,
    val slotIndex: Int
)

data class ReadinessCheck(
    val label: String,
    val passed: Boolean,
    val detail: String
)

data class GatewayReadinessResult(
    val localReady: Boolean,
    val checks: List<ReadinessCheck>
)

object GatewayReadinessEvaluator {
    fun evaluate(input: GatewayReadinessInput): GatewayReadinessResult {
        val slots = input.subscriptions.map(ReadinessSubscription::slotIndex)
        val subscriptionIds = input.subscriptions.map(ReadinessSubscription::subscriptionId)
        val twoDistinctSubscriptions =
            input.subscriptions.size == 2 &&
                slots.toSet().size == 2 &&
                subscriptionIds.toSet().size == 2 &&
                slots.toSet() == setOf(0, 1)
        val gatewayIsNotDefaultSms = !input.smsRoleHeld

        val checks = listOf(
            ReadinessCheck(
                label = "targetSdk 37",
                passed = input.targetSdk == 37,
                detail = "observed ${input.targetSdk}"
            ),
            ReadinessCheck(
                label = "Two distinct active SIMs",
                passed = twoDistinctSubscriptions,
                detail = if (input.subscriptions.isEmpty()) {
                    "none visible"
                } else {
                    input.subscriptions
                        .sortedBy(ReadinessSubscription::slotIndex)
                        .joinToString { "slot ${it.slotIndex}=subId ${it.subscriptionId}" }
                }
            ),
            ReadinessCheck(
                label = "RECEIVE_SMS",
                passed = input.receiveSmsGranted,
                detail = grantDetail(input.receiveSmsGranted)
            ),
            ReadinessCheck(
                label = "SEND_SMS",
                passed = input.sendSmsGranted,
                detail = grantDetail(input.sendSmsGranted)
            ),
            ReadinessCheck(
                label = "READ_PHONE_STATE",
                passed = input.readPhoneStateGranted,
                detail = grantDetail(input.readPhoneStateGranted)
            ),
            ReadinessCheck(
                label = "Gateway does not hold default SMS role",
                passed = gatewayIsNotDefaultSms,
                detail = if (input.smsRoleHeld) {
                    "Gateway currently holds ROLE_SMS"
                } else {
                    input.defaultSmsPackage?.let { "default package: $it" }
                        ?: "default package hidden; Gateway ROLE_SMS=false"
                }
            )
        )

        return GatewayReadinessResult(
            localReady = checks.all(ReadinessCheck::passed),
            checks = checks
        )
    }

    private fun grantDetail(granted: Boolean): String =
        if (granted) "granted" else "denied"
}
