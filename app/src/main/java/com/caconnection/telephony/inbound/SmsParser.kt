package com.caconnection.telephony.inbound

import android.content.Intent
import android.provider.Telephony

data class ParsedSms(
    val originatingAddress: String,
    val body: String,
    val receivedAt: Long,
    val partCount: Int
)

object SmsParser {
    fun parse(intent: Intent): ParsedSms? {
        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
        if (messages.isNullOrEmpty()) return null

        val address = messages.firstNotNullOfOrNull {
            it.originatingAddress?.takeIf(String::isNotBlank)
        }.orEmpty()
        val body = messages.joinToString(separator = "") {
            it.displayMessageBody ?: it.messageBody.orEmpty()
        }
        val timestamp = messages.map { it.timestampMillis }
            .filter { it > 0L }
            .minOrNull()
            ?: System.currentTimeMillis()

        return ParsedSms(
            originatingAddress = address,
            body = body,
            receivedAt = timestamp,
            partCount = messages.size
        )
    }
}
