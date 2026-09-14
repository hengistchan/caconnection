package com.caconnection.transport

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class GatewayProvisioningTest {
    private val secret =
        Base64.getEncoder().encodeToString(ByteArray(32) { it.toByte() })

    @Test
    fun publicCaProvisioningIsAccepted() {
        val document = GatewayProvisioning.parse(
            """
            {
              "schemaVersion": 1,
              "endpoint": "https://gateway.example.com/",
              "deviceId": "xiaomi-gateway",
              "sharedSecretBase64": "$secret",
              "certificatePinSha256Base64": "",
              "enabled": true
            }
            """.trimIndent()
        )

        assertEquals("https://gateway.example.com", document.endpoint)
        assertEquals("xiaomi-gateway", document.deviceId)
        assertTrue(document.enabled)
    }

    @Test
    fun omittedEnabledFlagDefaultsToEnabled() {
        val document = GatewayProvisioning.parse(
            """
            {
              "schemaVersion": 1,
              "endpoint": "https://gateway.example.com",
              "deviceId": "xiaomi-gateway",
              "sharedSecretBase64": "$secret",
              "certificatePinSha256Base64": ""
            }
            """.trimIndent()
        )

        assertTrue(document.enabled)
    }

    @Test
    fun invalidSchemaAndHttpAreRejected() {
        val invalidSchema = runCatching {
            GatewayProvisioning.parse(
                """{"schemaVersion":2,"endpoint":"https://gateway.example.com","deviceId":"xiaomi-gateway","sharedSecretBase64":"$secret"}"""
            )
        }.exceptionOrNull()
        val cleartext = runCatching {
            GatewayProvisioning.parse(
                """{"schemaVersion":1,"endpoint":"http://gateway.example.com","deviceId":"xiaomi-gateway","sharedSecretBase64":"$secret"}"""
            )
        }.exceptionOrNull()

        assertTrue(invalidSchema is IllegalArgumentException)
        assertTrue(cleartext is IllegalArgumentException)
    }
}
