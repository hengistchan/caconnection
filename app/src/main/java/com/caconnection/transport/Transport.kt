package com.caconnection.transport

/**
 * Interface for transmitting events to a remote endpoint.
 * Implementations should be stateless and thread-safe.
 */
interface Transport {
    /**
     * Send an event to the remote endpoint.
     * 
     * @param payload The serialized event data to send
     * @param idempotencyKey Unique key to prevent duplicate processing
     * @return TransportResult indicating success or failure
     */
    suspend fun send(payload: String, idempotencyKey: String): TransportResult
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