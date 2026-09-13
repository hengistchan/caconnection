package com.caconnection.transport

import com.google.gson.JsonParser
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.charset.StandardCharsets
import java.util.Base64
import javax.crypto.Mac
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
            "nonce-1"
        )
        val envelope = JsonParser.parseString(
            request.body.toString(StandardCharsets.UTF_8)
        ).asJsonObject

        assertEquals(1, envelope["schemaVersion"].asInt)
        assertEquals("delivery-1", envelope["deliveryId"].asString)
        assertEquals("INCOMING_SMS", envelope["eventType"].asString)
        assertEquals("hello", envelope["payload"].asJsonObject["body"].asString)

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

    private fun settings() = GatewayTransportSettings(
        enabled = true,
        endpoint = "http://127.0.0.1:8787",
        deviceId = "xiaomi-gateway",
        sharedSecretBase64 = secretBase64
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
