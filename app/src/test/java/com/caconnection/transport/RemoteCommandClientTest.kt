package com.caconnection.transport

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class RemoteCommandClientTest {
    private val settings = GatewayTransportSettings(
        enabled = true,
        endpoint = "https://gateway.example.test",
        deviceId = "xiaomi-gateway",
        sharedSecretBase64 = Base64.getEncoder()
            .encodeToString(ByteArray(32) { it.toByte() }),
        certificatePinSha256Base64 = ""
    )

    @Test
    fun claimsSignedRemoteSmsCommands() = runTest {
        var url = ""
        var headers = emptyMap<String, String>()
        val client = RemoteCommandClient(
            settings,
            httpClient = GatewayHttpClient { suppliedUrl, suppliedHeaders, _ ->
                url = suppliedUrl
                headers = suppliedHeaders
                GatewayHttpResponse(
                    200,
                    null,
                    """
                    {
                      "commands":[{
                        "commandId":"abcdefghijklmnop",
                        "deviceId":"xiaomi-gateway",
                        "slotIndex":1,
                        "recipient":"10086",
                        "body":"hello",
                        "status":"CLAIMED",
                        "createdAt":1000,
                        "expiresAt":200000
                      }]
                    }
                    """.trimIndent()
                )
            },
            now = { 123_456L },
            nonce = { "nonce-1" },
            requestId = { "claim-request-0001" }
        )

        val result = client.claim()

        assertTrue(result is RemoteCommandClaimResult.Success)
        val command = (result as RemoteCommandClaimResult.Success).commands.single()
        assertEquals("abcdefghijklmnop", command.commandId)
        assertEquals(1, command.slotIndex)
        assertEquals("10086", command.recipient)
        assertEquals(
            "https://gateway.example.test/v1/device-commands/claim",
            url
        )
        assertEquals("xiaomi-gateway", headers["X-Gateway-Device"])
        assertEquals("claim-request-0001", headers["Idempotency-Key"])
        assertTrue(headers["X-Gateway-Signature"].orEmpty().isNotBlank())
    }

    @Test
    fun mapsRetryableAndMalformedResponses() = runTest {
        val retry = RemoteCommandClient(
            settings,
            httpClient = GatewayHttpClient { _, _, _ ->
                GatewayHttpResponse(429, 5_000L)
            }
        ).claim()
        val malformed = RemoteCommandClient(
            settings,
            httpClient = GatewayHttpClient { _, _, _ ->
                GatewayHttpResponse(200, null, """{"commands":[{}]}""")
            }
        ).claim()

        assertEquals(
            RemoteCommandClaimResult.RetryableFailure(5_000L),
            retry
        )
        // A malformed entry rejects exactly that command — the claim itself
        // succeeded and the server has already marked the batch CLAIMED.
        assertEquals(
            RemoteCommandClaimResult.Success(
                commands = emptyList(),
                rejected = listOf(
                    RemoteCommandClaimResult.RejectedCommand(null, "Malformed command entry")
                )
            ),
            malformed
        )
    }

    @Test
    fun oneBadCommandDoesNotDiscardTheBatch() = runTest {
        val result = RemoteCommandClient(
            settings,
            httpClient = GatewayHttpClient { _, _, _ ->
                GatewayHttpResponse(
                    200,
                    null,
                    """
                    {
                      "commands":[
                        {
                          "commandId":"expiredcommandid1",
                          "deviceId":"xiaomi-gateway",
                          "slotIndex":0,
                          "recipient":"10086",
                          "body":"late",
                          "status":"CLAIMED",
                          "createdAt":1000,
                          "expiresAt":2000
                        },
                        {
                          "commandId":"validcommandid001",
                          "deviceId":"xiaomi-gateway",
                          "slotIndex":1,
                          "recipient":"10010",
                          "body":"hello",
                          "status":"CLAIMED",
                          "createdAt":1000,
                          "expiresAt":9000
                        }
                      ]
                    }
                    """.trimIndent()
                )
            },
            now = { 3_000L }
        ).claim()

        assertTrue(result is RemoteCommandClaimResult.Success)
        val success = result as RemoteCommandClaimResult.Success
        assertEquals(listOf("validcommandid001"), success.commands.map { it.commandId })
        assertEquals(1, success.rejected.size)
        assertEquals("expiredcommandid1", success.rejected[0].commandId)
    }

    @Test
    fun rejectsExpiredOrNonClaimedCommands() = runTest {
        val expired = RemoteCommandClient(
            settings,
            httpClient = GatewayHttpClient { _, _, _ ->
                GatewayHttpResponse(
                    200,
                    null,
                    """
                    {
                      "commands":[{
                        "commandId":"abcdefghijklmnop",
                        "deviceId":"xiaomi-gateway",
                        "slotIndex":0,
                        "recipient":"10086",
                        "body":"hello",
                        "status":"CLAIMED",
                        "createdAt":1000,
                        "expiresAt":2000
                      }]
                    }
                    """.trimIndent()
                )
            },
            now = { 3_000L }
        ).claim()
        val wrongStatus = RemoteCommandClient(
            settings,
            httpClient = GatewayHttpClient { _, _, _ ->
                GatewayHttpResponse(
                    200,
                    null,
                    """
                    {
                      "commands":[{
                        "commandId":"abcdefghijklmnop",
                        "deviceId":"xiaomi-gateway",
                        "slotIndex":0,
                        "recipient":"10086",
                        "body":"hello",
                        "status":"QUEUED",
                        "createdAt":1000,
                        "expiresAt":4000
                      }]
                    }
                    """.trimIndent()
                )
            },
            now = { 3_000L }
        ).claim()

        assertEquals(
            RemoteCommandClaimResult.Success(
                commands = emptyList(),
                rejected = listOf(
                    RemoteCommandClaimResult.RejectedCommand(
                        "abcdefghijklmnop",
                        "Expired before execution"
                    )
                )
            ),
            expired
        )
        assertEquals(
            RemoteCommandClaimResult.Success(
                commands = emptyList(),
                rejected = listOf(
                    RemoteCommandClaimResult.RejectedCommand(
                        "abcdefghijklmnop",
                        "Unexpected command status QUEUED"
                    )
                )
            ),
            wrongStatus
        )
    }
}
