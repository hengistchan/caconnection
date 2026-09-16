package com.caconnection.transport

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import javax.net.ssl.HttpsURLConnection

data class GatewayHttpResponse(
    val statusCode: Int,
    val retryAfterMillis: Long?,
    val body: String = ""
)

fun interface GatewayHttpClient {
    fun post(
        url: String,
        headers: Map<String, String>,
        body: ByteArray
    ): GatewayHttpResponse
}

class UrlConnectionGatewayHttpClient(
    certificatePinSha256Base64: String
) : GatewayHttpClient {
    private val sslSocketFactory =
        GatewayTls.socketFactory(certificatePinSha256Base64)

    override fun post(
        url: String,
        headers: Map<String, String>,
        body: ByteArray
    ): GatewayHttpResponse {
        val connection = URL(url).openConnection() as HttpURLConnection
        return try {
            if (connection is HttpsURLConnection && sslSocketFactory != null) {
                connection.sslSocketFactory = sslSocketFactory
            }
            connection.requestMethod = "POST"
            connection.connectTimeout = 5_000
            connection.readTimeout = 10_000
            connection.doOutput = true
            connection.instanceFollowRedirects = false
            headers.forEach(connection::setRequestProperty)
            connection.setFixedLengthStreamingMode(body.size)
            connection.outputStream.use { it.write(body) }
            val statusCode = connection.responseCode
            val retryAfterMillis = connection.getHeaderField("Retry-After")
                ?.trim()
                ?.toLongOrNull()
                ?.times(1_000L)
            val responseBody = runCatching {
                val stream = if (statusCode >= 400) {
                    connection.errorStream
                } else {
                    connection.inputStream
                }
                stream?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
            }.getOrDefault("")
            GatewayHttpResponse(statusCode, retryAfterMillis, responseBody)
        } finally {
            connection.disconnect()
        }
    }

}

class AuthenticatedHttpTransport(
    private val settings: GatewayTransportSettings,
    private val httpClient: GatewayHttpClient =
        UrlConnectionGatewayHttpClient(settings.certificatePinSha256Base64),
    private val now: () -> Long = System::currentTimeMillis,
    private val nonce: () -> String = { UUID.randomUUID().toString() }
) : Transport {
    override suspend fun send(event: TransportEvent): TransportResult =
        withContext(Dispatchers.IO) {
            val request = GatewayRequestSigner.sign(
                event = event,
                deviceId = settings.deviceId,
                sharedSecretBase64 = settings.sharedSecretBase64,
                timestampMillis = now(),
                nonce = nonce()
            )
            val response = runCatching {
                httpClient.post(
                    url = "${settings.endpoint}/v1/events",
                    headers = mapOf(
                        "Content-Type" to "application/json; charset=utf-8",
                        "X-Gateway-Device" to settings.deviceId,
                        "X-Gateway-Timestamp" to request.timestampMillis.toString(),
                        "X-Gateway-Nonce" to request.nonce,
                        "X-Gateway-Signature" to request.signatureBase64,
                        "Idempotency-Key" to event.idempotencyKey
                    ),
                    body = request.body
                )
            }.getOrElse {
                return@withContext TransportResult.RetryableFailure(
                    "Transport exception: ${it.javaClass.simpleName}"
                )
            }

            when {
                response.statusCode in 200..299 -> TransportResult.Success
                response.statusCode == 408 ||
                    response.statusCode == 425 ||
                    response.statusCode == 429 ||
                    response.statusCode >= 500 ->
                    TransportResult.RetryableFailure(
                        "HTTP ${response.statusCode}",
                        response.retryAfterMillis
                    )
                else -> TransportResult.PermanentFailure(
                    "HTTP ${response.statusCode}",
                    response.statusCode
                )
            }
        }
}
