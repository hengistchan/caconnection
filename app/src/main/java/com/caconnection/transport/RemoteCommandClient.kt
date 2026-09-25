package com.caconnection.transport

import com.google.gson.Gson
import com.google.gson.JsonParser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.UUID

data class RemoteSmsCommand(
    val commandId: String,
    val deviceId: String,
    val slotIndex: Int,
    val recipient: String,
    val body: String,
    val status: String,
    val createdAt: Long,
    val expiresAt: Long
)

sealed class RemoteCommandClaimResult {
    /**
     * A claim response. [rejected] commands failed validation individually —
     * one bad command must never discard the rest of the batch (the server has
     * already marked every row CLAIMED).
     */
    data class Success(
        val commands: List<RemoteSmsCommand>,
        val rejected: List<RejectedCommand> = emptyList()
    ) : RemoteCommandClaimResult()

    data class RejectedCommand(
        val commandId: String?,
        val reason: String
    )

    data class RetryableFailure(val retryAfterMillis: Long? = null) :
        RemoteCommandClaimResult()

    data class PermanentFailure(val statusCode: Int) :
        RemoteCommandClaimResult()
}

class RemoteCommandClient(
    private val settings: GatewayTransportSettings,
    private val httpClient: GatewayHttpClient =
        UrlConnectionGatewayHttpClient(settings.certificatePinSha256Base64),
    private val now: () -> Long = System::currentTimeMillis,
    private val nonce: () -> String = { UUID.randomUUID().toString() },
    private val requestId: () -> String = {
        "claim-${UUID.randomUUID()}"
    }
) {
    private val gson = Gson()

    private companion object {
        val COMMAND_ID_PATTERN = Regex("""[A-Za-z0-9_-]{16,128}""")
    }

    suspend fun claim(limit: Int = 5): RemoteCommandClaimResult =
        withContext(Dispatchers.IO) {
            val body = gson.toJson(
                mapOf("limit" to limit.coerceIn(1, 10))
            ).toByteArray(Charsets.UTF_8)
            val idempotencyKey = requestId()
            val signed = GatewayRequestSigner.signBody(
                body = body,
                deviceId = settings.deviceId,
                sharedSecretBase64 = settings.sharedSecretBase64,
                idempotencyKey = idempotencyKey,
                timestampMillis = now(),
                nonce = nonce()
            )
            val response = runCatching {
                httpClient.post(
                    url = "${settings.endpoint}/v1/device-commands/claim",
                    headers = mapOf(
                        "Content-Type" to "application/json; charset=utf-8",
                        "Accept" to "application/json",
                        "X-Gateway-Device" to settings.deviceId,
                        "X-Gateway-Timestamp" to signed.timestampMillis.toString(),
                        "X-Gateway-Nonce" to signed.nonce,
                        "X-Gateway-Signature" to signed.signatureBase64,
                        "Idempotency-Key" to idempotencyKey
                    ),
                    body = signed.body
                )
            }.getOrElse {
                return@withContext RemoteCommandClaimResult.RetryableFailure()
            }
            when {
                response.statusCode in 200..299 -> parseSuccess(
                    response.body,
                    now()
                )
                response.statusCode == 408 ||
                    response.statusCode == 425 ||
                    response.statusCode == 429 ||
                    response.statusCode >= 500 ->
                    RemoteCommandClaimResult.RetryableFailure(
                        response.retryAfterMillis
                    )
                else -> RemoteCommandClaimResult.PermanentFailure(
                    response.statusCode
                )
            }
        }

    private fun parseSuccess(
        body: String,
        receivedAt: Long
    ): RemoteCommandClaimResult {
        val root = runCatching { JsonParser.parseString(body).asJsonObject }
            .getOrElse { return RemoteCommandClaimResult.RetryableFailure() }
        val elements = runCatching {
            root["commands"]?.asJsonArray
                ?: error("claim response has no commands array")
        }.getOrElse { return RemoteCommandClaimResult.RetryableFailure() }

        val valid = mutableListOf<RemoteSmsCommand>()
        val rejected = mutableListOf<RemoteCommandClaimResult.RejectedCommand>()
        elements.forEach { element ->
            // Gson bypasses Kotlin null-safety for absent JSON fields, so the
            // validation itself is wrapped — a null field must reject one
            // command, never throw out of the parse loop.
            val command = runCatching {
                gson.fromJson(element, RemoteSmsCommand::class.java)
            }.getOrNull()
            val reason = if (command == null) {
                "Malformed command entry"
            } else {
                runCatching { validationError(command, receivedAt) }
                    .getOrElse { "Malformed command entry" }
            }
            if (command != null && reason == null) {
                valid += command
            } else {
                rejected += RemoteCommandClaimResult.RejectedCommand(
                    runCatching { command?.commandId }.getOrNull()
                        ?.takeIf { it.matches(COMMAND_ID_PATTERN) },
                    reason ?: "Malformed command entry"
                )
            }
        }
        return RemoteCommandClaimResult.Success(valid, rejected)
    }

    /**
     * Per-command validation. A failure rejects exactly one command — the
     * claim response as a whole is still usable.
     */
    private fun validationError(command: RemoteSmsCommand, receivedAt: Long): String? {
        if (!command.commandId.matches(COMMAND_ID_PATTERN)) return "Invalid command id"
        if (command.deviceId != settings.deviceId) return "Command targets another device"
        if (command.slotIndex !in 0..1) return "Invalid SIM slot"
        if (command.recipient.isBlank()) return "Missing recipient"
        if (command.body.isBlank()) return "Missing body"
        if (command.status != "CLAIMED") return "Unexpected command status ${command.status}"
        if (command.createdAt < 0) return "Invalid creation time"
        if (command.expiresAt <= command.createdAt) return "Invalid expiry"
        if (command.expiresAt <= receivedAt) return "Expired before execution"
        return null
    }
}
