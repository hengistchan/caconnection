package com.caconnection.telephony.inbound

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.provider.Telephony
import com.caconnection.data.poc.IncomingSmsEventEntity
import com.caconnection.data.poc.OutgoingSmsEventEntity

data class ProviderWriteResult(
    val status: String,
    val uri: String? = null,
    val error: String? = null
)

object DefaultSmsProviderWriter {
    /**
     * @param matchExisting when true, a row with the same date/address/body is
     *   treated as this message's earlier write (crash-replay protection).
     *   First-time processing must pass false: a content match would then eat
     *   a genuinely distinct second message with identical content, dropping
     *   it from the user's inbox.
     */
    fun saveIncoming(
        context: Context,
        event: IncomingSmsEventEntity,
        matchExisting: Boolean = false
    ): ProviderWriteResult {
        return runCatching {
            if (matchExisting) {
                findExistingIncoming(context, event)?.let {
                    return ProviderWriteResult(status = "SAVED", uri = it.toString())
                }
            }
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

    private fun findExistingIncoming(
        context: Context,
        event: IncomingSmsEventEntity
    ): Uri? = runCatching {
        val projection = arrayOf(Telephony.Sms._ID)
        val selection = buildString {
            append("${Telephony.TextBasedSmsColumns.DATE} = ?")
            append(" AND ${Telephony.TextBasedSmsColumns.ADDRESS} = ?")
            append(" AND ${Telephony.TextBasedSmsColumns.BODY} = ?")
        }
        val arguments = arrayOf(
            event.receivedAt.toString(),
            event.originatingAddress.orEmpty(),
            event.body.orEmpty()
        )
        context.contentResolver.query(
            Telephony.Sms.Inbox.CONTENT_URI,
            projection,
            selection,
            arguments,
            null
        )?.use { cursor ->
            if (!cursor.moveToFirst()) return@use null
            Uri.withAppendedPath(
                Telephony.Sms.Inbox.CONTENT_URI,
                cursor.getLong(0).toString()
            )
        }
    }.getOrNull()

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
