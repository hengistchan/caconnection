package com.caconnection.worker

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.caconnection.data.poc.OutboxEventEntity
import com.caconnection.data.poc.PocDatabase
import com.caconnection.transport.MockTransport
import com.caconnection.transport.Transport
import com.caconnection.transport.TransportResult
import kotlinx.coroutines.delay

/**
 * Worker that processes outbox events and sends them via Transport.
 * Implements exponential backoff for retryable failures.
 */
class OutboxWorker(
    context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {
    
    companion object {
        private const val TAG = "OutboxWorker"
        const val WORK_NAME = "outbox_processing"
        
        // Retry configuration
        private const val INITIAL_RETRY_DELAY_MS = 1000L // 1 second
        private const val MAX_RETRY_DELAY_MS = 300000L // 5 minutes
        private const val MAX_RETRY_COUNT = 10
        private const val BACKOFF_MULTIPLIER = 2.0
        
        // Batch size for processing
        private const val BATCH_SIZE = 10
    }
    
    // Transport is injected for testability
    var transport: Transport = MockTransport()
    
    override suspend fun doWork(): Result {
        Log.d(TAG, "Starting outbox processing")
        
        val database = PocDatabase.get(applicationContext)
        val dao = database.pocDao()
        
        return try {
            val currentTime = System.currentTimeMillis()
            
            // Process pending events first
            val pendingEvents = dao.getPendingOutboxEvents(currentTime, BATCH_SIZE)
            Log.d(TAG, "Processing ${pendingEvents.size} pending events")
            
            for (event in pendingEvents) {
                processEvent(dao, event)
            }
            
            // Then process retry events
            val retryEvents = dao.getRetryOutboxEvents(currentTime, BATCH_SIZE)
            Log.d(TAG, "Processing ${retryEvents.size} retry events")
            
            for (event in retryEvents) {
                processEvent(dao, event)
            }
            
            // Clean up successful events older than 24 hours
            // (In production, you might want to keep them longer for auditing)
            
            Log.d(TAG, "Outbox processing completed")
            Result.success()
        } catch (e: Exception) {
            Log.e(TAG, "Error processing outbox", e)
            Result.retry()
        }
    }
    
    private suspend fun processEvent(dao: com.caconnection.data.poc.PocDao, event: OutboxEventEntity) {
        Log.d(TAG, "Processing event ${event.eventId}, attempt ${event.retryCount + 1}")
        
        // Mark as in progress
        event.status = "IN_PROGRESS"
        event.updatedAt = System.currentTimeMillis()
        dao.updateOutbox(event)
        
        try {
            val result = transport.send(event.payloadData ?: "", event.idempotencyKey)
            
            when (result) {
                is TransportResult.Success -> {
                    Log.d(TAG, "Event ${event.eventId} sent successfully")
                    event.status = "SUCCESS"
                    event.updatedAt = System.currentTimeMillis()
                    dao.updateOutbox(event)
                }
                
                is TransportResult.RetryableFailure -> {
                    Log.w(TAG, "Event ${event.eventId} failed temporarily: ${result.error}")
                    handleRetryableFailure(dao, event, result)
                }
                
                is TransportResult.PermanentFailure -> {
                    Log.e(TAG, "Event ${event.eventId} failed permanently: ${result.error}")
                    event.status = "FAILED"
                    event.lastError = result.error
                    event.lastResultCode = result.errorCode
                    event.updatedAt = System.currentTimeMillis()
                    dao.updateOutbox(event)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Exception processing event ${event.eventId}", e)
            handleRetryableFailure(dao, event, TransportResult.RetryableFailure(e.message ?: "Unknown error"))
        }
    }
    
    private fun handleRetryableFailure(
        dao: com.caconnection.data.poc.PocDao,
        event: OutboxEventEntity,
        failure: TransportResult.RetryableFailure
    ) {
        val newRetryCount = event.retryCount + 1
        
        if (newRetryCount >= MAX_RETRY_COUNT) {
            Log.w(TAG, "Event ${event.eventId} exceeded max retries, marking as failed")
            event.status = "FAILED"
            event.lastError = "Exceeded maximum retry count ($MAX_RETRY_COUNT)"
            event.retryCount = newRetryCount
            event.updatedAt = System.currentTimeMillis()
            dao.updateOutbox(event)
            return
        }
        
        // Calculate next retry time with exponential backoff
        val retryDelay = failure.retryAfterMillis ?: calculateBackoffDelay(newRetryCount)
        val nextRetryAt = System.currentTimeMillis() + retryDelay
        
        Log.d(TAG, "Event ${event.eventId} scheduled for retry at $nextRetryAt (delay: ${retryDelay}ms)")
        
        event.status = "RETRY"
        event.retryCount = newRetryCount
        event.nextRetryAt = nextRetryAt
        event.lastError = failure.error
        event.updatedAt = System.currentTimeMillis()
        dao.updateOutbox(event)
    }
    
    /**
     * Calculate exponential backoff delay.
     * @param retryCount Current retry attempt (1-based)
     * @return Delay in milliseconds
     */
    private fun calculateBackoffDelay(retryCount: Int): Long {
        val delay = INITIAL_RETRY_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, (retryCount - 1).toDouble())
        return Math.min(delay.toLong(), MAX_RETRY_DELAY_MS)
    }
}