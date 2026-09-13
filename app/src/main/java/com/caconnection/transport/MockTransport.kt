package com.caconnection.transport

import android.util.Log
import kotlinx.coroutines.delay
import java.util.Collections

/**
 * Mock transport implementation for testing and development.
 * Simulates network behavior without actual network calls.
 */
class MockTransport : Transport {
    companion object {
        private const val TAG = "MockTransport"

        // Simulated failure rates for testing
        var simulatedFailureRate: Double = 0.0 // 0.0 to 1.0
        var simulatedPermanentFailureRate: Double = 0.0
        var simulatedLatencyMillis: Long = 100L

        // Track sent events for testing verification
        val sentEvents: MutableList<SentEvent> =
            Collections.synchronizedList(mutableListOf())

        data class SentEvent(
            val event: TransportEvent,
            val timestamp: Long = System.currentTimeMillis()
        )

        fun clearHistory() {
            sentEvents.clear()
        }
    }

    override suspend fun send(event: TransportEvent): TransportResult {
        Log.d(TAG, "Sending event with idempotency key: ${event.idempotencyKey}")

        // Simulate network latency
        if (simulatedLatencyMillis > 0) {
            try {
                delay(simulatedLatencyMillis)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                return TransportResult.RetryableFailure("Interrupted during latency simulation")
            }
        }

        // Simulate random failures
        val random = Math.random()
        if (random < simulatedPermanentFailureRate) {
            Log.w(TAG, "Simulated permanent failure for key: ${event.idempotencyKey}")
            return TransportResult.PermanentFailure(
                error = "Simulated permanent failure",
                errorCode = 400
            )
        }

        if (random < simulatedPermanentFailureRate + simulatedFailureRate) {
            Log.w(TAG, "Simulated temporary failure for key: ${event.idempotencyKey}")
            return TransportResult.RetryableFailure(
                error = "Simulated temporary failure",
                retryAfterMillis = 5000L // 5 seconds
            )
        }

        // Record successful send
        sentEvents.add(SentEvent(event))
        Log.d(TAG, "Successfully sent event with key: ${event.idempotencyKey}")

        return TransportResult.Success
    }
}
