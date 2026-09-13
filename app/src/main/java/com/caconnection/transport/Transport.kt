package com.caconnection.transport

data class TransportEvent(
    val deliveryId: String,
    val sourceEventId: String,
    val idempotencyKey: String,
    val eventType: String,
    val createdAt: Long,
    val subscriptionId: Int?,
    val slotIndex: Int?,
    val payloadData: String
)

/**
 * Interface for transmitting events to a remote endpoint.
 * Implementations should be stateless and thread-safe.
 */
fun interface Transport {
    suspend fun send(event: TransportEvent): TransportResult
}

/**
 * Result of a transport operation.
 */
sealed class TransportResult {
    /** Event was successfully delivered and acknowledged. */
    object Success : TransportResult()

    /**
     * Temporary failure - event should be retried later.
     * @param retryAfterMillis Suggested delay before retry, or null for exponential backoff
     */
    data class RetryableFailure(
        val error: String,
        val retryAfterMillis: Long? = null
    ) : TransportResult()

    /**
     * Permanent failure - event should not be retried.
     * @param error Description of the failure
     * @param errorCode Optional error code from the remote endpoint
     */
    data class PermanentFailure(
        val error: String,
        val errorCode: Int? = null
    ) : TransportResult()
}
