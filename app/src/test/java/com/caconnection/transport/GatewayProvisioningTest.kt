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

    private fun signedDocumentJson(
        endpoint: String = "https://attacker.example.com",
        enabled: Boolean = true,
        signature: String? = sign(endpoint, "xiaomi-gateway", secret, enabled)
    ): String {
        val signatureField = signature?.let { ""","signatureBase64":"$it"""" } ?: ""
        return """
            {
              "schemaVersion": 1,
              "endpoint": "$endpoint",
              "deviceId": "xiaomi-gateway",
              "sharedSecretBase64": "$secret",
              "certificatePinSha256Base64": "",
              "enabled": $enabled$signatureField
            }
            """.trimIndent()
    }

    private fun sign(
        endpoint: String,
        deviceId: String,
        sharedSecretBase64: String,
        enabled: Boolean
    ): String {
        val key = Base64.getDecoder().decode(secret)
        val message = listOf(
            GatewayProvisioning.SIGNING_MESSAGE_PREFIX,
            endpoint,
            deviceId,
            sharedSecretBase64,
            "",
            if (enabled) "true" else "false"
        ).joinToString("\n").toByteArray(Charsets.UTF_8)
        val mac = javax.crypto.Mac.getInstance("HmacSHA256")
        mac.init(javax.crypto.spec.SecretKeySpec(key, "HmacSHA256"))
        return Base64.getEncoder().encodeToString(mac.doFinal(message))
    }

    @Test
    fun validSignatureUnderCurrentSecretVerifies() {
        val document = GatewayProvisioning.parse(signedDocumentJson())

        assertTrue(GatewayProvisioning.verifySignature(document, secret))
    }

    @Test
    fun missingOrWrongSignatureIsRejected() {
        val unsigned = GatewayProvisioning.parse(signedDocumentJson(signature = null))
        val wrongKey = GatewayProvisioning.parse(signedDocumentJson())
        // Signature covers another endpoint than the document claims.
        val tampered = GatewayProvisioning.parse(
            signedDocumentJson(
                signature = sign("https://other.example.com", "xiaomi-gateway", secret, enabled = true)
            )
        )

        assertTrue(!GatewayProvisioning.verifySignature(unsigned, secret))
        assertTrue(
            !GatewayProvisioning.verifySignature(
                wrongKey,
                Base64.getEncoder().encodeToString(ByteArray(32) { 9 })
            )
        )
        assertTrue(!GatewayProvisioning.verifySignature(tampered, secret))
    }

    @Test
    fun disabledFlagIsCoveredByTheSignature() {
        val signedEnabled = GatewayProvisioning.parse(signedDocumentJson(enabled = true))
        val forgedDisabled = GatewayProvisioning.parse(
            signedDocumentJson(enabled = false, signature = sign(
                "https://attacker.example.com", "xiaomi-gateway", secret, enabled = true
            ))
        )

        assertTrue(GatewayProvisioning.verifySignature(signedEnabled, secret))
        assertTrue(!GatewayProvisioning.verifySignature(forgedDisabled, secret))
    }

    /**
     * Known-answer vector shared with server/setup_production.py
     * (test_production_support.py) — the canonical message and HMAC must stay
     * byte-identical across the Python generator and this verifier.
     */
    @Test
    fun matchesGeneratorKnownAnswerVector() {
        val document = GatewayProvisioning.parse(
            """
            {
              "schemaVersion": 1,
              "endpoint": "https://gateway.example.com",
              "deviceId": "xiaomi-gateway",
              "sharedSecretBase64": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
              "certificatePinSha256Base64": "",
              "enabled": true,
              "signatureBase64": "sPYwwSqqEkutn33600OMGH5IpL8cC+n6kQY/ioisRsE="
            }
            """.trimIndent()
        )

        assertTrue(
            GatewayProvisioning.verifySignature(
                document,
                "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
            )
        )
    }
}
