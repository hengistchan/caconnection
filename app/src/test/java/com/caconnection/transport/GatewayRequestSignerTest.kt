package com.caconnection.transport

import com.google.gson.JsonParser
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.charset.StandardCharsets
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class GatewayRequestSignerTest {
    private val secret = ByteArray(32) { it.toByte() }
    private val secretBase64 = Base64.getEncoder().encodeToString(secret)

    @Test
    fun envelopeAndSignatureMatchProtocol() {
        val event = event()
        val request = GatewayRequestSigner.sign(
            event,
            "xiaomi-gateway",
            secretBase64,
            123_456L,
            "nonce-1",
            ByteArray(12) { it.toByte() }
        )
        val body = request.body.toString(StandardCharsets.UTF_8)
        val envelope = JsonParser.parseString(
            body
        ).asJsonObject

        assertEquals(
            """{"schemaVersion":2,"deliveryId":"delivery-1","sourceEventId":"source-1","eventType":"INCOMING_SMS","createdAt":1000,"subscriptionId":1,"slotIndex":0,"payload":{"algorithm":"AES-256-GCM","nonceBase64":"AAECAwQFBgcICQoL","ciphertextBase64":"ywDPVPnJ7ZnrQg0WeKUL+gbZJr9dU/ukYrcqhlatcR0\u003d"}}""",
            body
        )
        assertEquals(2, envelope["schemaVersion"].asInt)
        assertEquals("delivery-1", envelope["deliveryId"].asString)
        assertEquals("INCOMING_SMS", envelope["eventType"].asString)
        val encrypted = envelope["payload"].asJsonObject
        assertEquals("AES-256-GCM", encrypted["algorithm"].asString)
        val encryptionKey = HkdfSha256.derive(
            secret,
            "xiaomi-gateway".toByteArray(StandardCharsets.UTF_8),
            "caconnection/payload-encryption/v1".toByteArray(StandardCharsets.UTF_8),
            32
        )
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(encryptionKey, "AES"),
            GCMParameterSpec(
                128,
                Base64.getDecoder().decode(encrypted["nonceBase64"].asString)
            )
        )
        cipher.updateAAD(GatewayRequestSigner.encryptionAad(event, "xiaomi-gateway"))
        val plaintext = cipher.doFinal(
            Base64.getDecoder().decode(encrypted["ciphertextBase64"].asString)
        ).toString(StandardCharsets.UTF_8)
        assertEquals("hello", JsonParser.parseString(plaintext).asJsonObject["body"].asString)
        assertTrue(!request.body.toString(StandardCharsets.UTF_8).contains("hello"))

        val canonical = listOf(
            "123456",
            "nonce-1",
            "xiaomi-gateway",
            "sms-key",
            GatewayRequestSigner.sha256Hex(request.body)
        ).joinToString("\n")
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret, "HmacSHA256"))
        val expected = Base64.getEncoder().encodeToString(
            mac.doFinal(canonical.toByteArray(StandardCharsets.UTF_8))
        )
        assertEquals(
            "661ZLTQKHvSSY69ZECEII/K9rb8xmnX50hJ9jCq5Klc=",
            expected
        )
        assertEquals(expected, request.signatureBase64)
    }

    @Test
    fun httpTransportSendsRequiredHeadersAndMapsSuccess() = runTest {
        var headers = emptyMap<String, String>()
        val transport = AuthenticatedHttpTransport(
            settings(),
            httpClient = GatewayHttpClient { _, suppliedHeaders, body ->
                headers = suppliedHeaders
                assertTrue(body.isNotEmpty())
                GatewayHttpResponse(201, null)
            },
            now = { 123_456L },
            nonce = { "nonce-1" }
        )

        val result = transport.send(event())

        assertEquals(TransportResult.Success, result)
        assertEquals("xiaomi-gateway", headers["X-Gateway-Device"])
        assertEquals("sms-key", headers["Idempotency-Key"])
        assertTrue(headers["X-Gateway-Signature"].orEmpty().isNotBlank())
    }

    @Test
    fun httpTransportMapsRetryableAndPermanentStatusCodes() = runTest {
        val retry = AuthenticatedHttpTransport(
            settings(),
            GatewayHttpClient { _, _, _ -> GatewayHttpResponse(429, 7_000L) }
        ).send(event())
        val permanent = AuthenticatedHttpTransport(
            settings(),
            GatewayHttpClient { _, _, _ -> GatewayHttpResponse(401, null) }
        ).send(event())

        assertEquals(
            TransportResult.RetryableFailure("HTTP 429", 7_000L),
            retry
        )
        assertEquals(
            TransportResult.PermanentFailure("HTTP 401", 401),
            permanent
        )
    }

    @Test
    fun transportExceptionIsRetryableWithoutLeakingEndpoint() = runTest {
        val result = AuthenticatedHttpTransport(
            settings(),
            GatewayHttpClient { _, _, _ -> error("secret endpoint detail") }
        ).send(event())

        assertEquals(
            TransportResult.RetryableFailure("Transport exception: IllegalStateException"),
            result
        )
    }

    @Test
    fun transportConfigurationRequiresHttpsAndValidPin() {
        GatewayTransportConfig.validate(
            "https://192.168.1.10:8787",
            "xiaomi-gateway",
            secretBase64,
            Base64.getEncoder().encodeToString(ByteArray(32) { 7 })
        )

        val httpFailure = runCatching {
            GatewayTransportConfig.validate(
                "http://192.168.1.10:8787",
                "xiaomi-gateway",
                secretBase64,
                Base64.getEncoder().encodeToString(ByteArray(32) { 7 })
            )
        }.exceptionOrNull()
        val pinFailure = runCatching {
            GatewayTransportConfig.validate(
                "https://192.168.1.10:8787",
                "xiaomi-gateway",
                secretBase64,
                Base64.getEncoder().encodeToString(ByteArray(31))
            )
        }.exceptionOrNull()

        assertTrue(httpFailure is IllegalArgumentException)
        assertEquals("HTTPS is required", httpFailure?.message)
        assertTrue(pinFailure is IllegalArgumentException)
        assertEquals(
            "Certificate pin must be a Base64 SHA-256 digest",
            pinFailure?.message
        )
    }

    private fun settings() = GatewayTransportSettings(
        enabled = true,
        endpoint = "https://127.0.0.1:8787",
        deviceId = "xiaomi-gateway",
        sharedSecretBase64 = secretBase64,
        certificatePinSha256Base64 =
            Base64.getEncoder().encodeToString(ByteArray(32) { 7 })
    )

    private fun event() = TransportEvent(
        deliveryId = "delivery-1",
        sourceEventId = "source-1",
        idempotencyKey = "sms-key",
        eventType = "INCOMING_SMS",
        createdAt = 1000L,
        subscriptionId = 1,
        slotIndex = 0,
        payloadData = """{"body":"hello"}"""
    )
}
