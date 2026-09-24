package com.caconnection.worker

import android.util.Log
import com.caconnection.data.poc.OutboxEventEntity
import com.caconnection.data.poc.OutboxStatus
import com.caconnection.transport.Transport
import com.caconnection.transport.TransportEvent
import com.caconnection.transport.TransportResult
import kotlinx.coroutines.CancellationException
import kotlin.math.min

data class RetryDecision(
    val status: OutboxStatus,
    val retryCount: Int,
    val nextRetryAt: Long,
    val lastError: String
)

object OutboxRetryPolicy {
    const val INITIAL_RETRY_DELAY_MS = 1_000L
    const val MAX_RETRY_DELAY_MS = 300_000L

    fun decide(
        currentRetryCount: Int,
        now: Long,
        error: String,
        retryAfterMillis: Long? = null
    ): RetryDecision {
        val newRetryCount =
            if (currentRetryCount == Int.MAX_VALUE) Int.MAX_VALUE
            else currentRetryCount + 1
        val delay = retryAfterMillis
            ?.coerceIn(0L, MAX_RETRY_DELAY_MS)
            ?: backoffDelay(newRetryCount)
        return RetryDecision(
            status = OutboxStatus.RETRY,
            retryCount = newRetryCount,
            nextRetryAt = now + delay,
            lastError = error
        )
    }

    fun backoffDelay(retryCount: Int): Long {
        val normalized = retryCount.coerceAtLeast(1)
        if (normalized >= 10) return MAX_RETRY_DELAY_MS
        return min(
            INITIAL_RETRY_DELAY_MS shl (normalized - 1),
            MAX_RETRY_DELAY_MS
        )
    }
}

class OutboxProcessor(
    private val transport: Transport,
    private val now: () -> Long = System::currentTimeMillis
) {
    companion object {
        private const val TAG = "OutboxProcessor"
    }

    suspend fun process(
        event: OutboxEventEntity,
        persist: (OutboxEventEntity) -> Unit
    ): OutboxStatus {
        event.status = OutboxStatus.IN_PROGRESS.name
        event.updatedAt = now()
        persist(event)

        val payload = event.payloadData
        if (payload == null) {
            markPermanentFailure(event, "Missing payload", null, persist)
            return OutboxStatus.FAILED
        }

        val transportEvent = TransportEvent(
            deliveryId = event.eventId,
            sourceEventId = event.incomingEventId,
            idempotencyKey = event.idempotencyKey,
            eventType = event.payloadType ?: "UNKNOWN",
            createdAt = event.createdAt,
            subscriptionId = event.subscriptionId,
            slotIndex = event.slotIndex,
            payloadData = payload
        )
        val result = try {
            transport.send(transportEvent)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Exception) {
            Log.w(TAG, "Transport exception id=${event.eventId}", error)
            TransportResult.RetryableFailure(error.message ?: error.javaClass.simpleName)
        }

        return when (result) {
            TransportResult.Success -> {
                event.status = OutboxStatus.SUCCESS.name
                event.lastError = null
                event.lastResultCode = null
                event.updatedAt = now()
                persist(event)
                OutboxStatus.SUCCESS
            }

            is TransportResult.RetryableFailure -> {
                val decision = OutboxRetryPolicy.decide(
                    currentRetryCount = event.retryCount,
                    now = now(),
                    error = result.error,
                    retryAfterMillis = result.retryAfterMillis
                )
                Log.w(
                    TAG,
                    "Retryable send failure id=${event.eventId} type=${event.payloadType} " +
                        "retry=${decision.retryCount} error=${result.error}"
                )
                event.status = decision.status.name
                event.retryCount = decision.retryCount
                event.nextRetryAt = decision.nextRetryAt
                event.lastError = decision.lastError
                event.updatedAt = now()
                persist(event)
                OutboxStatus.RETRY
            }

            is TransportResult.PermanentFailure -> {
                Log.e(
                    TAG,
                    "Permanent send failure id=${event.eventId} type=${event.payloadType} " +
                        "code=${result.errorCode} error=${result.error}"
                )
                markPermanentFailure(event, result.error, result.errorCode, persist)
                OutboxStatus.FAILED
            }
        }
    }

    private fun markPermanentFailure(
        event: OutboxEventEntity,
        error: String,
        resultCode: Int?,
        persist: (OutboxEventEntity) -> Unit
    ) {
        event.status = OutboxStatus.FAILED.name
        event.lastError = error
        event.lastResultCode = resultCode
        event.updatedAt = now()
        persist(event)
    }
}
