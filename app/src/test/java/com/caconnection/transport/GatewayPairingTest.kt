package com.caconnection.transport

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class GatewayPairingTest {
    private val token = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789"
    private val secret = Base64.getEncoder().encodeToString(ByteArray(32) { it.toByte() })

    @Test
    fun pairingCodeIsStrictlyParsedAndNormalized() {
        val document = GatewayPairing.parse(
            """{"schemaVersion":1,"type":"ca-connection-pairing","endpoint":"https://gateway.example.com/","pairingToken":"$token"}"""
        )

        assertEquals("https://gateway.example.com", document.endpoint)
        assertEquals(token, document.pairingToken)
    }

    @Test
    fun cleartextUnknownFieldsAndShortTokensAreRejected() {
        listOf(
            """{"schemaVersion":1,"type":"ca-connection-pairing","endpoint":"http://gateway.example.com","pairingToken":"$token"}""",
            """{"schemaVersion":1,"type":"ca-connection-pairing","endpoint":"https://gateway.example.com","pairingToken":"short"}""",
            """{"schemaVersion":1,"type":"ca-connection-pairing","endpoint":"https://gateway.example.com","pairingToken":"$token","sharedSecretBase64":"leak"}"""
        ).forEach {
            assertTrue(runCatching { GatewayPairing.parse(it) }.isFailure)
        }
    }

    @Test
    fun claimerAcceptsMatchingProvisioningAndRejectsReuse() {
        val document = GatewayPairing.parse(
            """{"schemaVersion":1,"type":"ca-connection-pairing","endpoint":"https://gateway.example.com","pairingToken":"$token"}"""
        )
        val claimer = GatewayPairingClaimer {
            PairingHttpResponse(
                200,
                """{"provisioning":{"schemaVersion":1,"endpoint":"https://gateway.example.com","deviceId":"xiaomi-gateway","sharedSecretBase64":"$secret","certificatePinSha256Base64":"","enabled":true}}"""
            )
        }

        assertEquals("xiaomi-gateway", claimer.claim(document).deviceId)

        val expired = runCatching {
            GatewayPairingClaimer { PairingHttpResponse(410, "{}") }.claim(document)
        }.exceptionOrNull() as GatewayPairingException
        assertEquals(PairingFailure.EXPIRED_OR_USED, expired.failure)
    }
}
