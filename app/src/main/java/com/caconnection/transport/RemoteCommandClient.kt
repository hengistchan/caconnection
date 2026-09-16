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
    data class Success(val commands: List<RemoteSmsCommand>) :
        RemoteCommandClaimResult()

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
        return runCatching {
            val root = JsonParser.parseString(body).asJsonObject
            val commands = root["commands"].asJsonArray.map { element ->
                gson.fromJson(element, RemoteSmsCommand::class.java).also {
                    require(it.commandId.matches(Regex("""[A-Za-z0-9_-]{16,128}""")))
                    require(it.deviceId == settings.deviceId)
                    require(it.slotIndex in 0..1)
                    require(it.recipient.isNotBlank())
                    require(it.body.isNotBlank())
                    require(it.status == "CLAIMED")
                    require(it.createdAt >= 0)
                    require(it.expiresAt > it.createdAt)
                    require(it.expiresAt > receivedAt)
                }
            }
            RemoteCommandClaimResult.Success(commands)
        }.getOrElse {
            RemoteCommandClaimResult.PermanentFailure(502)
        }
    }
}
