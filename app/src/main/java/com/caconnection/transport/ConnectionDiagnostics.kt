package com.caconnection.transport

import android.util.Log
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.net.URL
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

enum class DiagnosticStage {
    CONFIGURATION,
    DNS,
    TCP,
    TLS,
    HEALTH,
    READY,
    AUTHENTICATION
}

data class DiagnosticStep(
    val stage: DiagnosticStage,
    val passed: Boolean,
    val durationMillis: Long,
    val detail: String
)

data class ConnectionDiagnosticReport(val steps: List<DiagnosticStep>) {
    val passed: Boolean get() = steps.size == DiagnosticStage.entries.size &&
        steps.all(DiagnosticStep::passed)

    fun sanitizedText(): String = steps.joinToString("\n") {
        "${it.stage.name}: ${if (it.passed) "PASS" else "FAIL"} " +
            "(${it.durationMillis} ms) ${sanitize(it.detail)}"
    }

    companion object {
        fun sanitize(value: String): String = value
            .replace(
                Regex("""(?i)(token|secret|password|authorization)\s*[:=]\s*\S+"""),
                "$1=[REDACTED]"
            )
            .replace(Regex("""https?://\S+"""), "[URL]")
            .replace(Regex("""\+?\d[\d ()-]{6,}\d"""), "[NUMBER]")
            .take(160)
    }
}

class ConnectionDiagnostics(
    private val nowNanos: () -> Long = System::nanoTime,
    private val resolve: (String) -> Unit = { InetAddress.getAllByName(it) },
    private val tcpConnect: (String, Int) -> Unit = { host, port ->
        Socket().use { it.connect(InetSocketAddress(host, port), 5_000) }
    },
    private val tlsHandshake: (String, Int, String) -> Unit = { host, port, pin ->
        val factory = GatewayTls.socketFactory(pin)
            ?: SSLSocketFactory.getDefault() as SSLSocketFactory
        (factory.createSocket(host, port) as SSLSocket).use { socket ->
            socket.soTimeout = 7_000
            socket.sslParameters = socket.sslParameters.apply {
                endpointIdentificationAlgorithm = "HTTPS"
            }
            socket.startHandshake()
        }
    },
    private val getStatus: (String, String) -> Int = { url, pin ->
        val connection = URL(url).openConnection() as HttpsURLConnection
        try {
            GatewayTls.socketFactory(pin)?.let {
                connection.sslSocketFactory = it
            }
            connection.connectTimeout = 5_000
            connection.readTimeout = 7_000
            connection.instanceFollowRedirects = false
            connection.requestMethod = "GET"
            connection.responseCode
        } finally {
            connection.disconnect()
        }
    },
    private val sendAuthenticationTest: suspend (GatewayTransportSettings) -> TransportResult = {
        AuthenticatedHttpTransport(it).send(
            TransportEvent(
                deliveryId = "diagnostic-${System.currentTimeMillis()}",
                sourceEventId = "diagnostic",
                idempotencyKey = "diagnostic-${java.util.UUID.randomUUID()}",
                eventType = "LOCAL_SELF_TEST",
                createdAt = System.currentTimeMillis(),
                subscriptionId = null,
                slotIndex = null,
                payloadData = """{"type":"CONNECTION_DIAGNOSTIC","safe":true}"""
            )
        )
    }
) {
    private companion object {
        const val TAG = "ConnectionDiagnostics"
    }

    suspend fun run(settings: GatewayTransportSettings): ConnectionDiagnosticReport {
        val steps = mutableListOf<DiagnosticStep>()
        fun execute(stage: DiagnosticStage, action: () -> String): Boolean {
            val started = nowNanos()
            return try {
                val detail = action()
                val durationMillis = (nowNanos() - started) / 1_000_000
                steps += DiagnosticStep(
                    stage,
                    true,
                    durationMillis,
                    detail
                )
                Log.i(TAG, "Diagnostic stage=$stage passed durationMs=$durationMillis detail=$detail")
                true
            } catch (error: Exception) {
                val durationMillis = (nowNanos() - started) / 1_000_000
                val detail = diagnosticErrorDetail(error)
                steps += DiagnosticStep(
                    stage,
                    false,
                    durationMillis,
                    detail
                )
                Log.w(
                    TAG,
                    "Diagnostic stage=$stage failed durationMs=$durationMillis detail=$detail",
                    error
                )
                false
            }
        }

        if (!execute(DiagnosticStage.CONFIGURATION) {
                GatewayTransportConfig.validate(
                    settings.endpoint,
                    settings.deviceId,
                    settings.sharedSecretBase64,
                    settings.certificatePinSha256Base64
                )
                check(settings.enabled) { "Gateway is disabled" }
                check(settings.configured) { "Gateway configuration is incomplete" }
                "valid"
            }
        ) return ConnectionDiagnosticReport(steps)

        val uri = URI(settings.endpoint)
        val host = uri.host
        val port = if (uri.port == -1) 443 else uri.port
        if (!execute(DiagnosticStage.DNS) {
                resolve(host)
                "resolved"
            }
        ) return ConnectionDiagnosticReport(steps)
        if (!execute(DiagnosticStage.TCP) {
                tcpConnect(host, port)
                "connected"
            }
        ) return ConnectionDiagnosticReport(steps)
        if (!execute(DiagnosticStage.TLS) {
                tlsHandshake(host, port, settings.certificatePinSha256Base64)
                if (settings.certificatePinSha256Base64.isBlank()) "system CA" else "pin verified"
            }
        ) return ConnectionDiagnosticReport(steps)
        if (!execute(DiagnosticStage.HEALTH) {
                val status = getStatus(
                    "${settings.endpoint}/health",
                    settings.certificatePinSha256Base64
                )
                checkHttpStatus(status)
            }
        ) return ConnectionDiagnosticReport(steps)
        if (!execute(DiagnosticStage.READY) {
                val status = getStatus(
                    "${settings.endpoint}/ready",
                    settings.certificatePinSha256Base64
                )
                checkHttpStatus(status)
            }
        ) return ConnectionDiagnosticReport(steps)

        val started = nowNanos()
        val result = runCatching { sendAuthenticationTest(settings) }
        val passed = result.getOrNull() == TransportResult.Success
        steps += DiagnosticStep(
            DiagnosticStage.AUTHENTICATION,
            passed,
            (nowNanos() - started) / 1_000_000,
            when (val value = result.getOrNull()) {
                TransportResult.Success -> "encrypted test accepted"
                is TransportResult.PermanentFailure -> "HTTP ${value.errorCode ?: "rejected"}"
                is TransportResult.RetryableFailure -> "temporary failure"
                null -> result.exceptionOrNull()?.javaClass?.simpleName ?: "failed"
            }
        )
        return ConnectionDiagnosticReport(steps)
    }

    private fun checkHttpStatus(status: Int): String {
        if (status != 200) throw DiagnosticHttpStatusException(status)
        return "HTTP 200"
    }

    private fun diagnosticErrorDetail(error: Exception): String {
        if (error is DiagnosticHttpStatusException) return "HTTP ${error.statusCode}"
        val message = error.message.orEmpty().trim()
        return if (message.isBlank()) {
            error.javaClass.simpleName
        } else {
            "${error.javaClass.simpleName}: $message"
        }
    }
}

private class DiagnosticHttpStatusException(val statusCode: Int) :
    Exception("HTTP $statusCode")
