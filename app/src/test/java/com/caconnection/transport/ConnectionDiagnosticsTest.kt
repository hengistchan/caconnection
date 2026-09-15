package com.caconnection.transport

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class ConnectionDiagnosticsTest {
    private val settings = GatewayTransportSettings(
        enabled = true,
        endpoint = "https://gateway.example.com",
        deviceId = "xiaomi-gateway",
        sharedSecretBase64 = Base64.getEncoder().encodeToString(ByteArray(32)),
        certificatePinSha256Base64 = ""
    )

    @Test
    fun allStagesPassInOrder() = runTest {
        var clock = 0L
        val report = ConnectionDiagnostics(
            nowNanos = { clock.also { clock += 1_000_000 } },
            resolve = {},
            tcpConnect = { _, _ -> },
            tlsHandshake = { _, _, _ -> },
            getStatus = { _, _ -> 200 },
            sendAuthenticationTest = { TransportResult.Success }
        ).run(settings)

        assertTrue(report.passed)
        assertEquals(DiagnosticStage.entries, report.steps.map { it.stage })
        assertTrue(report.sanitizedText().contains("AUTHENTICATION: PASS"))
    }

    @Test
    fun failureStopsAtTheFailedStageWithoutSensitiveDetails() = runTest {
        val report = ConnectionDiagnostics(
            resolve = { error("https://secret.example token=abc123456") }
        ).run(settings)

        assertFalse(report.passed)
        assertEquals(
            listOf(DiagnosticStage.CONFIGURATION, DiagnosticStage.DNS),
            report.steps.map { it.stage }
        )
        assertFalse(report.sanitizedText().contains("secret.example"))
        assertFalse(report.sanitizedText().contains("abc123456"))
    }

    @Test
    fun reportSanitizerRedactsUrlsTokensAndPhoneNumbers() {
        val sanitized = ConnectionDiagnosticReport.sanitize(
            "https://gateway.example token=abcdef phone +86 138-1234-5678"
        )

        assertTrue(sanitized.contains("[URL]"))
        assertTrue(sanitized.contains("token=[REDACTED]"))
        assertTrue(sanitized.contains("[NUMBER]"))
    }
}
