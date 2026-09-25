package com.caconnection.transport

import com.google.gson.Gson
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

data class GatewayProvisioningDocument(
    val schemaVersion: Int,
    val endpoint: String,
    val deviceId: String,
    val sharedSecretBase64: String,
    val certificatePinSha256Base64: String?,
    val enabled: Boolean = true,
    val signatureBase64: String? = null
)

object GatewayProvisioning {
    private val gson = Gson()

    fun parse(value: String): GatewayProvisioningDocument {
        require(value.toByteArray(Charsets.UTF_8).size <= MAX_BYTES) {
            "Provisioning document is too large"
        }
        val raw = gson.fromJson(
            value,
            RawGatewayProvisioningDocument::class.java
        ) ?: throw IllegalArgumentException("Invalid provisioning document")
        require(raw.schemaVersion == 1) {
            "Unsupported provisioning schema"
        }
        val endpoint = raw.endpoint.orEmpty().trim().trimEnd('/')
        val deviceId = raw.deviceId.orEmpty().trim()
        val sharedSecret = raw.sharedSecretBase64.orEmpty().trim()
        val certificatePin = raw.certificatePinSha256Base64.orEmpty().trim()
        GatewayTransportConfig.validate(
            endpoint,
            deviceId,
            sharedSecret,
            certificatePin
        )
        return GatewayProvisioningDocument(
            schemaVersion = raw.schemaVersion,
            endpoint = endpoint,
            deviceId = deviceId,
            sharedSecretBase64 = sharedSecret,
            certificatePinSha256Base64 = certificatePin,
            enabled = raw.enabled ?: true,
            signatureBase64 = raw.signatureBase64?.trim()
        )
    }

    /**
     * Canonical bytes covered by the provisioning signature. Built from the
     * normalized field values so generator and verifier cannot disagree on
     * whitespace. Field order is fixed — never reorder without a new prefix.
     */
    fun signingMessage(document: GatewayProvisioningDocument): ByteArray =
        listOf(
            SIGNING_MESSAGE_PREFIX,
            document.endpoint,
            document.deviceId,
            document.sharedSecretBase64,
            document.certificatePinSha256Base64.orEmpty(),
            if (document.enabled) "true" else "false"
        ).joinToString("\n").toByteArray(Charsets.UTF_8)

    /**
     * Verify a provisioning document against the secret the device already
     * holds. Only that secret proves the document came from the operator —
     * anyone with ADB access can write the file.
     */
    fun verifySignature(
        document: GatewayProvisioningDocument,
        currentSecretBase64: String
    ): Boolean {
        val provided = document.signatureBase64
            ?.takeIf(String::isNotBlank)
            ?.let { runCatching { Base64.getDecoder().decode(it) }.getOrNull() }
            ?: return false
        val key = runCatching {
            Base64.getDecoder().decode(currentSecretBase64)
        }.getOrNull() ?: return false
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        val expected = mac.doFinal(signingMessage(document))
        return java.security.MessageDigest.isEqual(expected, provided)
    }

    const val FILE_NAME = "gateway-provisioning.json"
    const val MAX_BYTES = 16_384
    const val SIGNING_MESSAGE_PREFIX = "caconnection/provisioning/v1"

    private data class RawGatewayProvisioningDocument(
        val schemaVersion: Int = 0,
        val endpoint: String? = null,
        val deviceId: String? = null,
        val sharedSecretBase64: String? = null,
        val certificatePinSha256Base64: String? = null,
        val enabled: Boolean? = null,
        val signatureBase64: String? = null
    )
}
