package com.caconnection.transport

import com.google.gson.Gson
import com.google.gson.JsonParser
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

data class GatewayEnvelope(
    val schemaVersion: Int = 1,
    val deliveryId: String,
    val sourceEventId: String,
    val eventType: String,
    val createdAt: Long,
    val subscriptionId: Int?,
    val slotIndex: Int?,
    val payload: Any
)

data class SignedGatewayRequest(
    val body: ByteArray,
    val timestampMillis: Long,
    val nonce: String,
    val signatureBase64: String
)

object GatewayRequestSigner {
    private val gson = Gson()

    fun sign(
        event: TransportEvent,
        deviceId: String,
        sharedSecretBase64: String,
        timestampMillis: Long,
        nonce: String
    ): SignedGatewayRequest {
        val payload = JsonParser.parseString(event.payloadData)
        val envelope = GatewayEnvelope(
            deliveryId = event.deliveryId,
            sourceEventId = event.sourceEventId,
            eventType = event.eventType,
            createdAt = event.createdAt,
            subscriptionId = event.subscriptionId,
            slotIndex = event.slotIndex,
            payload = payload
        )
        val body = gson.toJson(envelope).toByteArray(StandardCharsets.UTF_8)
        val bodyHash = sha256Hex(body)
        val canonical = listOf(
            timestampMillis.toString(),
            nonce,
            deviceId,
            event.idempotencyKey,
            bodyHash
        ).joinToString("\n")
        val key = Base64.getDecoder().decode(sharedSecretBase64)
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        val signature = mac.doFinal(canonical.toByteArray(StandardCharsets.UTF_8))
        return SignedGatewayRequest(
            body = body,
            timestampMillis = timestampMillis,
            nonce = nonce,
            signatureBase64 = Base64.getEncoder().encodeToString(signature)
        )
    }

    fun sha256Hex(value: ByteArray): String =
        MessageDigest.getInstance("SHA-256")
            .digest(value)
            .joinToString(separator = "") { byte -> "%02x".format(byte) }
}
