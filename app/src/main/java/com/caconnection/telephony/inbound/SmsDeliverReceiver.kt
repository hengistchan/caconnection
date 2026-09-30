package com.caconnection.telephony.inbound

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log

class SmsDeliverReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_DELIVER_ACTION) return
        val pendingResult = goAsync()
        Log.i(TAG, "Accepted SMS_DELIVER broadcast; starting durable processing")
        IncomingSmsProcessor.process(context.applicationContext, intent) {
            pendingResult.finish()
        }
    }

    companion object {
        private const val TAG = "SmsDeliverReceiver"
    }
}
