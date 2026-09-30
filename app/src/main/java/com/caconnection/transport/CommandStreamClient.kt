package com.caconnection.transport

import android.content.Context
import android.util.Log
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import javax.net.ssl.HttpsURLConnection

/**
 * Availability-layer command stream (ADR-003).
 *
 * Holds one signed long-lived `POST /v1/device-commands/stream` SSE
 * connection while the foreground gateway is up. Frames are advisory
 * "commands queued" nudges — never command content — and each one triggers
 * an immediate claim through the normal RemoteCommand pipeline. If this
 * whole object fails, nothing is lost: WorkManager polling remains the
 * fallback and the server keeps every unclaimed command.
 */
object CommandStreamClient {
    private const val TAG = "CommandStreamClient"
    private const val PATH = "/v1/device-commands/stream"
    private const val CONNECT_TIMEOUT_MS = 10_000

    // The server heartbeats every 25 s; a read longer than this means the
    // connection is half-open and must be rebuilt.
    private const val READ_TIMEOUT_MS = 90_000
    private const val STREAM_TOPIC = """{"stream":"commands"}"""

    private val lock = Any()
    private var thread: Thread? = null
    private var activeConnection: HttpURLConnection? = null
    private var activeContext: Context? = null
    private var activeSettings: GatewayTransportSettings? = null
    private var activeNow: (() -> Long)? = null
    private var activeNonce: (() -> String)? = null
    private var activeConnectionCallback: ((Boolean) -> Unit)? = null
    private var activeCommandCallback: (() -> Unit)? = null
    private var activeHeartbeatCallback: (() -> Unit)? = null

    /**
     * Bumped on every start/stop. A loop thread exits as soon as it notices
     * its generation is stale, so a restart can never leave two readers
     * racing on one device identity.
     */
    private var generation = 0

    /**
     * Start (or restart) the stream. A no-op while an identical session is
     * already running; changed transport settings tear the old session down
     * and reconnect under the new ones.
     */
    fun start(
        context: Context,
        settings: GatewayTransportSettings,
        now: () -> Long = System::currentTimeMillis,
        nonce: () -> String = { UUID.randomUUID().toString() },
        onConnectionChanged: (Boolean) -> Unit = {},
        onCommandQueued: () -> Unit,
        onHeartbeat: () -> Unit = {}
    ) {
        val stale: HttpURLConnection?
        val myGeneration: Int
        synchronized(lock) {
            if (thread?.isAlive == true && activeSettings == settings) return
            generation += 1
            myGeneration = generation
            stale = activeConnection.also { activeConnection = null }
            activeSettings = settings
            activeContext = context.applicationContext
            activeNow = now
            activeNonce = nonce
            activeConnectionCallback = onConnectionChanged
            activeCommandCallback = onCommandQueued
            activeHeartbeatCallback = onHeartbeat
            thread?.interrupt()
            thread = Thread(
                {
                    runLoop(
                        myGeneration,
                        context.applicationContext,
                        settings,
                        now,
                        nonce,
                        onConnectionChanged,
                        onCommandQueued,
                        onHeartbeat
                    )
                },
                "command-stream"
            ).apply {
                isDaemon = true
                start()
            }
        }
        runCatching { stale?.disconnect() }
    }

    fun stop() {
        val connection = synchronized(lock) {
            generation += 1
            thread?.interrupt()
            thread = null
            activeSettings = null
            activeContext = null
            activeNow = null
            activeNonce = null
            activeConnectionCallback = null
            activeCommandCallback = null
            activeHeartbeatCallback = null
            activeConnection.also { activeConnection = null }
        }
        // Closing the socket is what unblocks the reader thread.
        runCatching { connection?.disconnect() }
            .onFailure { Log.w(TAG, "Unable to tear down command stream", it) }
    }

    fun forceReconnect(reason: String) {
        synchronized(lock) {
            val settings = activeSettings ?: return
            val session = ReconnectSession(
                context = activeContext ?: return,
                settings = settings,
                now = activeNow ?: System::currentTimeMillis,
                nonce = activeNonce ?: { UUID.randomUUID().toString() },
                onConnectionChanged = activeConnectionCallback ?: {},
                onCommandQueued = activeCommandCallback ?: {},
                onHeartbeat = activeHeartbeatCallback ?: {}
            )
            // Keep snapshot, stop and restart under the same re-entrant lock.
            // Otherwise simultaneous network/watchdog recovery can stop the
            // connection that another caller has just created.
            Log.w(TAG, "Forcing command stream reconnect reason=$reason")
            stop()
            start(
                context = session.context,
                settings = session.settings,
                now = session.now,
                nonce = session.nonce,
                onConnectionChanged = session.onConnectionChanged,
                onCommandQueued = session.onCommandQueued,
                onHeartbeat = session.onHeartbeat
            )
        }
    }

    val isRunning: Boolean
        get() = synchronized(lock) { thread?.isAlive == true }

    private fun runLoop(
        myGeneration: Int,
        context: Context,
        settings: GatewayTransportSettings,
        now: () -> Long,
        nonce: () -> String,
        onConnectionChanged: (Boolean) -> Unit,
        onCommandQueued: () -> Unit,
        onHeartbeat: () -> Unit
    ) {
        while (isCurrent(myGeneration)) {
            val gateDelayMs = GatewayRateLimitStore.acquireRequestSlot(
                context,
                "command-stream"
            )
            if (gateDelayMs > 0L) {
                Log.w(
                    TAG,
                    "Skipping command stream reconnect while Gateway gate is closed " +
                        "remainingMs=$gateDelayMs source=${GatewayRateLimitStore.lastSource(context)}"
                )
                try {
                    Thread.sleep(gateDelayMs)
                } catch (interrupted: InterruptedException) {
                    Thread.currentThread().interrupt()
                    break
                }
                continue
            }
            val failure = runCatching {
                openAndRead(
                    myGeneration,
                    context,
                    settings,
                    now,
                    nonce,
                    onConnectionChanged,
                    onCommandQueued,
                    onHeartbeat
                )
            }.exceptionOrNull()
            if (!isCurrent(myGeneration)) break
            CommandStreamState.onDisconnected(failure?.let { describe(it) })
            runCatching { onConnectionChanged(false) }
                .onFailure { Log.e(TAG, "Command stream disconnect handler failed", it) }
            val delay = CommandStreamState.nextReconnectDelayMillis()
            Log.w(TAG, "Command stream closed; retrying in ${delay}ms", failure)
            try {
                Thread.sleep(delay)
            } catch (interrupted: InterruptedException) {
                Thread.currentThread().interrupt()
                break
            }
        }
    }

    /**
     * One stream session: connect, dispatch nudges until the server or the
     * socket ends the session. Returns normally on a clean end, throws on
     * connection/protocol failure — the loop above treats both as "reconnect".
     */
    private fun openAndRead(
        myGeneration: Int,
        context: Context,
        settings: GatewayTransportSettings,
        now: () -> Long,
        nonce: () -> String,
        onConnectionChanged: (Boolean) -> Unit,
        onCommandQueued: () -> Unit,
        onHeartbeat: () -> Unit
    ) {
        val body = STREAM_TOPIC.toByteArray(Charsets.UTF_8)
        val idempotencyKey = "stream-${UUID.randomUUID()}"
        val signed = GatewayRequestSigner.signBody(
            body = body,
            deviceId = settings.deviceId,
            sharedSecretBase64 = settings.sharedSecretBase64,
            idempotencyKey = idempotencyKey,
            timestampMillis = now(),
            nonce = nonce()
        )
        val connection = URL("${settings.endpoint}$PATH").openConnection() as HttpURLConnection
        synchronized(lock) {
            if (generation != myGeneration) {
                connection.disconnect()
                return
            }
            activeConnection = connection
        }
        try {
            if (connection is HttpsURLConnection) {
                GatewayTls.socketFactory(settings.certificatePinSha256Base64)?.let {
                    connection.sslSocketFactory = it
                }
            }
            connection.requestMethod = "POST"
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS
            connection.doOutput = true
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            connection.setRequestProperty("Accept", "text/event-stream")
            connection.setRequestProperty("X-Gateway-Device", settings.deviceId)
            connection.setRequestProperty("X-Gateway-Timestamp", signed.timestampMillis.toString())
            connection.setRequestProperty("X-Gateway-Nonce", signed.nonce)
            connection.setRequestProperty("X-Gateway-Signature", signed.signatureBase64)
            connection.setRequestProperty("Idempotency-Key", idempotencyKey)
            connection.setFixedLengthStreamingMode(signed.body.size)
            connection.outputStream.use { it.write(signed.body) }

            val status = connection.responseCode
            if (status != 200) {
                if (status == 429) {
                    val retryAfterMillis = connection.getHeaderField("Retry-After")
                        ?.trim()
                        ?.toLongOrNull()
                        ?.times(1_000L)
                    GatewayRateLimitStore.recordRateLimit(
                        context = context,
                        source = "command-stream",
                        retryAfterMillis = retryAfterMillis,
                        now = now()
                    )
                }
                throw IOException("Command stream rejected with HTTP $status")
            }
            CommandStreamState.onConnected(now())
            runCatching { onConnectionChanged(true) }
                .onFailure { Log.e(TAG, "Command stream connect handler failed", it) }

            val parser = SseFrameParser {
                val heartbeatAt = now()
                CommandStreamState.onHeartbeat(heartbeatAt)
                runCatching { onHeartbeat() }
                    .onFailure { Log.e(TAG, "Command stream heartbeat handler failed", it) }
            }
            connection.inputStream.bufferedReader().use { reader ->
                while (isCurrent(myGeneration)) {
                    val line = reader.readLine() ?: break
                    val event = parser.onLine(line) ?: continue
                    if (event.event == "command_queued") {
                        CommandStreamState.onCommandQueued(now())
                        runCatching { onCommandQueued() }
                            .onFailure { error ->
                                Log.e(TAG, "Command stream nudge handler failed", error)
                            }
                    }
                }
            }
        } finally {
            synchronized(lock) {
                if (activeConnection === connection) activeConnection = null
            }
            runCatching { connection.disconnect() }
        }
    }

    private fun isCurrent(myGeneration: Int): Boolean =
        synchronized(lock) { generation == myGeneration }

    private fun describe(error: Throwable): String =
        "${error.javaClass.simpleName}: ${error.message.orEmpty()}"
            .take(128)

    private data class ReconnectSession(
        val context: Context,
        val settings: GatewayTransportSettings,
        val now: () -> Long,
        val nonce: () -> String,
        val onConnectionChanged: (Boolean) -> Unit,
        val onCommandQueued: () -> Unit,
        val onHeartbeat: () -> Unit
    )
}
