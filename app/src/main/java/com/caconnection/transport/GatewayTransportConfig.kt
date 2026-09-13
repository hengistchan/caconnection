package com.caconnection.transport

import android.content.Context
import androidx.core.content.edit
import com.caconnection.BuildConfig
import java.net.URI
import java.util.Base64

data class GatewayTransportSettings(
    val enabled: Boolean,
    val endpoint: String,
    val deviceId: String,
    val sharedSecretBase64: String
) {
    val configured: Boolean
        get() = endpoint.isNotBlank() &&
            deviceId.isNotBlank() &&
            sharedSecretBase64.isNotBlank()
}

object GatewayTransportConfig {
    private const val PREFERENCES = "gateway_transport"
    private const val KEY_ENABLED = "enabled"
    private const val KEY_ENDPOINT = "endpoint"
    private const val KEY_DEVICE_ID = "device_id"
    private const val KEY_SHARED_SECRET = "shared_secret_base64"

    fun load(context: Context): GatewayTransportSettings {
        val preferences =
            context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        return GatewayTransportSettings(
            enabled = preferences.getBoolean(KEY_ENABLED, false),
            endpoint = preferences.getString(KEY_ENDPOINT, "").orEmpty(),
            deviceId = preferences.getString(KEY_DEVICE_ID, "").orEmpty(),
            sharedSecretBase64 =
                preferences.getString(KEY_SHARED_SECRET, "").orEmpty()
        )
    }

    fun save(
        context: Context,
        enabled: Boolean,
        endpoint: String,
        deviceId: String,
        replacementSecretBase64: String?
    ): GatewayTransportSettings {
        val current = load(context)
        val normalizedEndpoint = endpoint.trim().trimEnd('/')
        val normalizedDeviceId = deviceId.trim()
        val secret = replacementSecretBase64
            ?.trim()
            ?.takeIf(String::isNotEmpty)
            ?: current.sharedSecretBase64
        validate(normalizedEndpoint, normalizedDeviceId, secret)
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit {
            putBoolean(KEY_ENABLED, enabled)
            putString(KEY_ENDPOINT, normalizedEndpoint)
            putString(KEY_DEVICE_ID, normalizedDeviceId)
            putString(KEY_SHARED_SECRET, secret)
        }
        return load(context)
    }

    fun validate(endpoint: String, deviceId: String, secretBase64: String) {
        if (endpoint.isBlank() && deviceId.isBlank() && secretBase64.isBlank()) return
        require(deviceId.matches(Regex("""[A-Za-z0-9._-]{3,64}"""))) {
            "Device ID must be 3-64 letters, digits, dots, underscores, or hyphens"
        }
        val uri = runCatching { URI(endpoint) }
            .getOrElse { throw IllegalArgumentException("Invalid endpoint URL") }
        require(uri.scheme == "https" || (BuildConfig.DEBUG && uri.scheme == "http")) {
            "Release builds require HTTPS; debug builds may use HTTP"
        }
        require(!uri.host.isNullOrBlank()) { "Endpoint must include a host" }
        require(runCatching {
            Base64.getDecoder().decode(secretBase64).size >= 32
        }.getOrDefault(false)) {
            "Shared secret must be Base64 and decode to at least 32 bytes"
        }
    }
}

object GatewayTransportFactory {
    fun create(context: Context): Transport {
        val settings = GatewayTransportConfig.load(context)
        return if (settings.enabled && settings.configured) {
            AuthenticatedHttpTransport(settings)
        } else {
            MockTransport()
        }
    }
}
