package com.caconnection.transport

import com.google.gson.Gson

data class GatewayProvisioningDocument(
    val schemaVersion: Int,
    val endpoint: String,
    val deviceId: String,
    val sharedSecretBase64: String,
    val certificatePinSha256Base64: String?,
    val enabled: Boolean = true
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
            enabled = raw.enabled ?: true
        )
    }

    const val FILE_NAME = "gateway-provisioning.json"
    const val MAX_BYTES = 16_384

    private data class RawGatewayProvisioningDocument(
        val schemaVersion: Int = 0,
        val endpoint: String? = null,
        val deviceId: String? = null,
        val sharedSecretBase64: String? = null,
        val certificatePinSha256Base64: String? = null,
        val enabled: Boolean? = null
    )
}
