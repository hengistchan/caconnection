package com.caconnection.transport

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
    suspend fun run(settings: GatewayTransportSettings): ConnectionDiagnosticReport {
        val steps = mutableListOf<DiagnosticStep>()
        fun execute(stage: DiagnosticStage, action: () -> String): Boolean {
            val started = nowNanos()
            return try {
                val detail = action()
                steps += DiagnosticStep(
                    stage,
                    true,
                    (nowNanos() - started) / 1_000_000,
                    detail
                )
                true
            } catch (error: Exception) {
                steps += DiagnosticStep(
                    stage,
                    false,
                    (nowNanos() - started) / 1_000_000,
                    error.javaClass.simpleName
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
                require(settings.enabled && settings.configured)
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
                require(getStatus("${settings.endpoint}/health", settings.certificatePinSha256Base64) == 200)
                "HTTP 200"
            }
        ) return ConnectionDiagnosticReport(steps)
        if (!execute(DiagnosticStage.READY) {
                require(getStatus("${settings.endpoint}/ready", settings.certificatePinSha256Base64) == 200)
                "HTTP 200"
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
}
