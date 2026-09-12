package com.caconnection.telephony.inbound

import android.content.ContentValues
import android.content.Context
import android.provider.Telephony
import com.caconnection.data.poc.IncomingSmsEventEntity
import com.caconnection.data.poc.OutgoingSmsEventEntity

data class ProviderWriteResult(
    val status: String,
    val uri: String? = null,
    val error: String? = null
)

object DefaultSmsProviderWriter {
    fun saveIncoming(context: Context, event: IncomingSmsEventEntity): ProviderWriteResult {
        return runCatching {
            val values = ContentValues().apply {
                put(Telephony.TextBasedSmsColumns.ADDRESS, event.originatingAddress)
                put(Telephony.TextBasedSmsColumns.BODY, event.body)
                put(Telephony.TextBasedSmsColumns.DATE, event.receivedAt)
                put(Telephony.TextBasedSmsColumns.DATE_SENT, event.receivedAt)
                put(Telephony.TextBasedSmsColumns.READ, 0)
                put(Telephony.TextBasedSmsColumns.SEEN, 0)
                event.resolvedSubscriptionId?.let {
                    put(Telephony.TextBasedSmsColumns.SUBSCRIPTION_ID, it)
                }
            }
            val uri = context.contentResolver.insert(Telephony.Sms.Inbox.CONTENT_URI, values)
                ?: error("SMS Provider returned no URI")
            ProviderWriteResult(status = "SAVED", uri = uri.toString())
        }.getOrElse {
            ProviderWriteResult(
                status = "FAILED",
                error = "${it.javaClass.simpleName}: ${it.message.orEmpty()}"
            )
        }
    }

    fun saveOutgoing(context: Context, event: OutgoingSmsEventEntity): ProviderWriteResult {
        return runCatching {
            val values = ContentValues().apply {
                put(Telephony.TextBasedSmsColumns.ADDRESS, event.recipient)
                put(Telephony.TextBasedSmsColumns.BODY, event.body)
                put(Telephony.TextBasedSmsColumns.DATE, event.updatedAt)
                put(Telephony.TextBasedSmsColumns.DATE_SENT, event.updatedAt)
                put(Telephony.TextBasedSmsColumns.READ, 1)
                put(Telephony.TextBasedSmsColumns.SEEN, 1)
                put(Telephony.TextBasedSmsColumns.SUBSCRIPTION_ID, event.requestedSubscriptionId)
            }
            val uri = context.contentResolver.insert(Telephony.Sms.Sent.CONTENT_URI, values)
                ?: error("SMS Provider returned no URI")
            ProviderWriteResult(status = "SAVED", uri = uri.toString())
        }.getOrElse {
            ProviderWriteResult(
                status = "FAILED",
                error = "${it.javaClass.simpleName}: ${it.message.orEmpty()}"
            )
        }
    }
}
