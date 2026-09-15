package com.caconnection.transport

import com.google.gson.Gson
import com.google.gson.JsonParser
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.nio.charset.StandardCharsets
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLException

data class GatewayPairingDocument(
    val schemaVersion: Int,
    val type: String,
    val endpoint: String,
    val pairingToken: String,
    val certificatePinSha256Base64: String
)

object GatewayPairing {
    const val TYPE = "ca-connection-pairing"
    const val MAX_BYTES = 4_096
    private val gson = Gson()
    private val tokenPattern = Regex("""[A-Za-z0-9_-]{32,128}""")

    fun parse(value: String): GatewayPairingDocument {
        require(value.toByteArray(StandardCharsets.UTF_8).size <= MAX_BYTES) {
            "Pairing code is too large"
        }
        val root = runCatching { JsonParser.parseString(value).asJsonObject }
            .getOrElse { throw IllegalArgumentException("Invalid pairing code") }
        val allowedFields = setOf(
                "schemaVersion",
                "type",
                "endpoint",
                "pairingToken",
                "certificatePinSha256Base64"
            )
        require(root.keySet().all(allowedFields::contains)) {
            "Unsupported pairing fields"
        }
        val raw = gson.fromJson(root, RawPairingDocument::class.java)
        require(raw.schemaVersion == 1 && raw.type == TYPE) {
            "Unsupported pairing code"
        }
        val endpoint = raw.endpoint.orEmpty().trim().trimEnd('/')
        val token = raw.pairingToken.orEmpty().trim()
        val pin = raw.certificatePinSha256Base64.orEmpty().trim()
        validateEndpoint(endpoint)
        require(tokenPattern.matches(token)) { "Invalid pairing token" }
        if (pin.isNotBlank()) {
            require(runCatching {
                java.util.Base64.getDecoder().decode(pin).size == 32
            }.getOrDefault(false)) {
                "Invalid certificate pin"
            }
        }
        return GatewayPairingDocument(1, TYPE, endpoint, token, pin)
    }

    private fun validateEndpoint(endpoint: String) {
        val uri = runCatching { URI(endpoint) }
            .getOrElse { throw IllegalArgumentException("Invalid endpoint URL") }
        require(uri.scheme == "https" && !uri.host.isNullOrBlank()) {
            "HTTPS endpoint is required"
        }
        require(uri.userInfo == null && uri.query == null && uri.fragment == null) {
            "Invalid endpoint URL"
        }
        require(uri.path.isNullOrEmpty() || uri.path == "/") {
            "Endpoint must be an HTTPS origin"
        }
        require(uri.port == -1 || uri.port in 1..65535) {
            "Invalid endpoint port"
        }
    }

    private data class RawPairingDocument(
        val schemaVersion: Int = 0,
        val type: String? = null,
        val endpoint: String? = null,
        val pairingToken: String? = null,
        val certificatePinSha256Base64: String? = null
    )
}

data class PairingHttpResponse(val statusCode: Int, val body: String)

fun interface PairingHttpClient {
    fun claim(document: GatewayPairingDocument): PairingHttpResponse
}

class UrlConnectionPairingHttpClient : PairingHttpClient {
    override fun claim(document: GatewayPairingDocument): PairingHttpResponse {
        val connection = URL(
            "${document.endpoint}/v1/pairings/claim"
        ).openConnection() as HttpsURLConnection
        return try {
            GatewayTls.socketFactory(document.certificatePinSha256Base64)?.let {
                connection.sslSocketFactory = it
            }
            connection.requestMethod = "POST"
            connection.connectTimeout = 7_000
            connection.readTimeout = 10_000
            connection.instanceFollowRedirects = false
            connection.doOutput = true
            connection.setRequestProperty(
                "Content-Type",
                "application/json; charset=utf-8"
            )
            connection.setRequestProperty("Accept", "application/json")
            val body = Gson().toJson(
                mapOf("pairingToken" to document.pairingToken)
            ).toByteArray(StandardCharsets.UTF_8)
            connection.setFixedLengthStreamingMode(body.size)
            connection.outputStream.use { it.write(body) }
            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            PairingHttpResponse(
                status,
                stream?.use { it.readBytes().toString(StandardCharsets.UTF_8) }.orEmpty()
            )
        } finally {
            connection.disconnect()
        }
    }
}

enum class PairingFailure {
    INVALID_CODE,
    EXPIRED_OR_USED,
    TLS,
    NETWORK,
    SERVER
}

class GatewayPairingException(
    val failure: PairingFailure,
    cause: Throwable? = null
) : Exception(failure.name, cause)

class GatewayPairingClaimer(
    private val client: PairingHttpClient = UrlConnectionPairingHttpClient()
) {
    fun claim(document: GatewayPairingDocument): GatewayProvisioningDocument {
        val response = try {
            client.claim(document)
        } catch (error: SSLException) {
            throw GatewayPairingException(PairingFailure.TLS, error)
        } catch (error: Exception) {
            throw GatewayPairingException(PairingFailure.NETWORK, error)
        }
        if (response.statusCode == HttpURLConnection.HTTP_GONE) {
            throw GatewayPairingException(PairingFailure.EXPIRED_OR_USED)
        }
        if (response.statusCode !in 200..299) {
            throw GatewayPairingException(PairingFailure.SERVER)
        }
        val provisioningJson = try {
            JsonParser.parseString(response.body)
                .asJsonObject["provisioning"]
                .asJsonObject
                .toString()
        } catch (error: Exception) {
            throw GatewayPairingException(PairingFailure.SERVER, error)
        }
        val provisioning = try {
            GatewayProvisioning.parse(provisioningJson)
        } catch (error: Exception) {
            throw GatewayPairingException(PairingFailure.SERVER, error)
        }
        if (
            provisioning.endpoint != document.endpoint ||
            provisioning.certificatePinSha256Base64.orEmpty() !=
            document.certificatePinSha256Base64
        ) {
            throw GatewayPairingException(PairingFailure.SERVER)
        }
        return provisioning
    }
}
