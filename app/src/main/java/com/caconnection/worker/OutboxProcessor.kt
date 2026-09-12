package com.caconnection.worker

import com.caconnection.data.poc.OutboxEventEntity
import com.caconnection.data.poc.OutboxStatus
import com.caconnection.transport.Transport
import com.caconnection.transport.TransportResult
import kotlinx.coroutines.CancellationException
import kotlin.math.min
import kotlin.math.pow

data class RetryDecision(
    val status: OutboxStatus,
    val retryCount: Int,
    val nextRetryAt: Long,
    val lastError: String
)

object OutboxRetryPolicy {
    const val INITIAL_RETRY_DELAY_MS = 1_000L
    const val MAX_RETRY_DELAY_MS = 300_000L
    const val MAX_RETRY_COUNT = 10

    fun decide(
        currentRetryCount: Int,
        now: Long,
        error: String,
        retryAfterMillis: Long? = null
    ): RetryDecision {
        val newRetryCount = currentRetryCount + 1
        if (newRetryCount >= MAX_RETRY_COUNT) {
            return RetryDecision(
                status = OutboxStatus.FAILED,
                retryCount = newRetryCount,
                nextRetryAt = now,
                lastError = "Exceeded maximum retry count ($MAX_RETRY_COUNT): $error"
            )
        }

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
        val exponent = (retryCount.coerceAtLeast(1) - 1).toDouble()
        return min(
            (INITIAL_RETRY_DELAY_MS * 2.0.pow(exponent)).toLong(),
            MAX_RETRY_DELAY_MS
        )
    }
}

class OutboxProcessor(
    private val transport: Transport,
    private val now: () -> Long = System::currentTimeMillis
) {
    suspend fun process(
        event: OutboxEventEntity,
        persist: (OutboxEventEntity) -> Unit
    ) {
        event.status = OutboxStatus.IN_PROGRESS.name
        event.updatedAt = now()
        persist(event)

        val payload = event.payloadData
        if (payload == null) {
            markPermanentFailure(event, "Missing payload", null, persist)
            return
        }

        val result = try {
            transport.send(payload, event.idempotencyKey)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Exception) {
            TransportResult.RetryableFailure(error.message ?: error.javaClass.simpleName)
        }

        when (result) {
            TransportResult.Success -> {
                event.status = OutboxStatus.SUCCESS.name
                event.lastError = null
                event.lastResultCode = null
                event.updatedAt = now()
                persist(event)
            }

            is TransportResult.RetryableFailure -> {
                val decision = OutboxRetryPolicy.decide(
                    currentRetryCount = event.retryCount,
                    now = now(),
                    error = result.error,
                    retryAfterMillis = result.retryAfterMillis
                )
                event.status = decision.status.name
                event.retryCount = decision.retryCount
                event.nextRetryAt = decision.nextRetryAt
                event.lastError = decision.lastError
                event.updatedAt = now()
                persist(event)
            }

            is TransportResult.PermanentFailure ->
                markPermanentFailure(event, result.error, result.errorCode, persist)
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
