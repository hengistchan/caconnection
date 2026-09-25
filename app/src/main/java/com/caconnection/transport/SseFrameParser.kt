package com.caconnection.transport

/**
 * Minimal server-sent-events parser for the command stream.
 *
 * Only what the protocol (ADR-003) uses: `event:`, `data:`, `retry:` and
 * comment/heartbeat lines. One [Event] per blank-line-terminated frame;
 * data is joined across `data:` lines per the SSE spec.
 */
class SseFrameParser {
    data class Event(val event: String?, val data: String)

    private val dataLines = mutableListOf<String>()
    private var eventName: String? = null

    /**
     * Feed one line (without its trailing newline). Returns the completed
     * event when this line terminates a frame, otherwise null. Comment lines
     * (heartbeats) never produce events.
     */
    fun onLine(line: String): Event? {
        val trimmed = line.removeSuffix("\r")
        if (trimmed.isEmpty()) return flush()
        if (trimmed.startsWith(":")) return null
        when {
            trimmed.startsWith("event:") ->
                eventName = trimmed.removePrefix("event:").trim()
            trimmed.startsWith("data:") ->
                dataLines += trimmed.removePrefix("data:").trim()
            trimmed.startsWith("retry:") ->
                Unit // reconnect hint; the client runs its own backoff
            else -> Unit // unknown field — ignore per SSE spec
        }
        return null
    }

    private fun flush(): Event? {
        if (dataLines.isEmpty() && eventName == null) return null
        val event = Event(eventName, dataLines.joinToString("\n"))
        eventName = null
        dataLines.clear()
        return event
    }
}
