package com.caconnection.transport

import com.google.gson.Gson
import com.google.gson.JsonParser
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Outbound envelope version. Bound into the payload AAD so a recipient cannot
 * reinterpret the ciphertext under another schema version without breaking
 * the GCM tag. Must stay in sync with the server's payload-crypto.
 */
private const val OUTBOUND_SCHEMA_VERSION = 2

data class GatewayEnvelope(
    val schemaVersion: Int = OUTBOUND_SCHEMA_VERSION,
    val deliveryId: String,
    val sourceEventId: String,
    val eventType: String,
    val createdAt: Long,
    val subscriptionId: Int?,
    val slotIndex: Int?,
    val payload: EncryptedGatewayPayload
)

data class EncryptedGatewayPayload(
    val algorithm: String = "AES-256-GCM",
    val nonceBase64: String,
    val ciphertextBase64: String
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
        nonce: String,
        encryptionNonce: ByteArray = ByteArray(12).also {
            SecureRandom().nextBytes(it)
        }
    ): SignedGatewayRequest {
        JsonParser.parseString(event.payloadData).asJsonObject
        require(encryptionNonce.size == 12) { "AES-GCM nonce must be 12 bytes" }
        val sharedSecret = Base64.getDecoder().decode(sharedSecretBase64)
        val aad = encryptionAad(event, deviceId)
        val encryptionKey = HkdfSha256.derive(
            inputKeyMaterial = sharedSecret,
            salt = deviceId.toByteArray(StandardCharsets.UTF_8),
            info = "caconnection/payload-encryption/v1".toByteArray(StandardCharsets.UTF_8),
            length = 32
        )
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(encryptionKey, "AES"),
            GCMParameterSpec(128, encryptionNonce)
        )
        cipher.updateAAD(aad)
        val ciphertext = cipher.doFinal(
            event.payloadData.toByteArray(StandardCharsets.UTF_8)
        )
        val envelope = GatewayEnvelope(
            deliveryId = event.deliveryId,
            sourceEventId = event.sourceEventId,
            eventType = event.eventType,
            createdAt = event.createdAt,
            subscriptionId = event.subscriptionId,
            slotIndex = event.slotIndex,
            payload = EncryptedGatewayPayload(
                nonceBase64 = Base64.getEncoder().encodeToString(encryptionNonce),
                ciphertextBase64 = Base64.getEncoder().encodeToString(ciphertext)
            )
        )
        val body = gson.toJson(envelope).toByteArray(StandardCharsets.UTF_8)
        return signBody(
            body = body,
            deviceId = deviceId,
            sharedSecretBase64 = sharedSecretBase64,
            idempotencyKey = event.idempotencyKey,
            timestampMillis = timestampMillis,
            nonce = nonce
        )
    }

    fun signBody(
        body: ByteArray,
        deviceId: String,
        sharedSecretBase64: String,
        idempotencyKey: String,
        timestampMillis: Long,
        nonce: String
    ): SignedGatewayRequest {
        val sharedSecret = Base64.getDecoder().decode(sharedSecretBase64)
        val bodyHash = sha256Hex(body)
        val canonical = listOf(
            timestampMillis.toString(),
            nonce,
            deviceId,
            idempotencyKey,
            bodyHash
        ).joinToString("\n")
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(sharedSecret, "HmacSHA256"))
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

    fun encryptionAad(event: TransportEvent, deviceId: String): ByteArray =
        listOf(
            OUTBOUND_SCHEMA_VERSION.toString(),
            event.deliveryId,
            event.sourceEventId,
            event.eventType,
            event.createdAt.toString(),
            event.subscriptionId?.toString().orEmpty(),
            event.slotIndex?.toString().orEmpty(),
            deviceId
        ).joinToString("\n").toByteArray(StandardCharsets.UTF_8)
}

object HkdfSha256 {
    fun derive(
        inputKeyMaterial: ByteArray,
        salt: ByteArray,
        info: ByteArray,
        length: Int
    ): ByteArray {
        require(length in 1..(255 * 32))
        val extract = Mac.getInstance("HmacSHA256")
        extract.init(SecretKeySpec(salt, "HmacSHA256"))
        val pseudorandomKey = extract.doFinal(inputKeyMaterial)
        val output = ByteArray(length)
        var previous = ByteArray(0)
        var offset = 0
        var counter = 1
        while (offset < length) {
            val expand = Mac.getInstance("HmacSHA256")
            expand.init(SecretKeySpec(pseudorandomKey, "HmacSHA256"))
            expand.update(previous)
            expand.update(info)
            expand.update(counter.toByte())
            previous = expand.doFinal()
            val count = minOf(previous.size, length - offset)
            previous.copyInto(output, offset, 0, count)
            offset += count
            counter += 1
        }
        return output
    }
}
