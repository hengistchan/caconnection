package com.caconnection.telephony.outbound

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.caconnection.data.poc.PocEventStore

class SmsSentReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val eventId = intent.getStringExtra(SmsGatewaySender.EXTRA_EVENT_ID) ?: return
        val partIndex = intent.getIntExtra(SmsGatewaySender.EXTRA_PART_INDEX, -1)
        if (partIndex < 0) return
        PocEventStore.get(context).recordSentCallback(eventId, partIndex, resultCode)
    }

    companion object {
        const val ACTION_SMS_SENT = "com.caconnection.action.SMS_SENT"
    }
}
