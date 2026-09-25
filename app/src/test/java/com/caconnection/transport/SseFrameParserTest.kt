package com.caconnection.transport

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SseFrameParserTest {
    @Test
    fun parsesCommandQueuedEvent() {
        val parser = SseFrameParser()

        assertNull(parser.onLine("retry: 15000"))
        assertNull(parser.onLine(""))
        assertNull(parser.onLine("event: command_queued"))
        assertNull(parser.onLine("""data: {"deviceId":"device-a","pending":1}"""))
        val event = parser.onLine("")

        assertEquals("command_queued", event?.event)
        assertEquals("""{"deviceId":"device-a","pending":1}""", event?.data)
    }

    @Test
    fun heartbeatsProduceNoEvents() {
        val parser = SseFrameParser()

        assertNull(parser.onLine(": ping"))
        assertNull(parser.onLine(""))
    }

    @Test
    fun joinsMultiLineData() {
        val parser = SseFrameParser()

        parser.onLine("event: command_queued")
        parser.onLine("data: {\"a\":")
        parser.onLine("data: 1}")
        val event = parser.onLine("")

        assertEquals("{\"a\":\n1}", event?.data)
    }

    @Test
    fun resetsBetweenFrames() {
        val parser = SseFrameParser()

        parser.onLine("event: command_queued")
        parser.onLine("data: first")
        val first = parser.onLine("")
        parser.onLine("data: second")
        val second = parser.onLine("")

        assertEquals(SseFrameParser.Event("command_queued", "first"), first)
        // The second frame inherits no event name from the first.
        assertEquals(SseFrameParser.Event(null, "second"), second)
    }

    @Test
    fun toleratesCarriageReturnsAndUnknownFields() {
        val parser = SseFrameParser()

        assertNull(parser.onLine("id: 7"))
        assertNull(parser.onLine("event: command_queued\r"))
        assertNull(parser.onLine("data: payload\r"))
        val event = parser.onLine("\r")

        assertEquals("command_queued", event?.event)
        assertEquals("payload", event?.data)
    }
}
