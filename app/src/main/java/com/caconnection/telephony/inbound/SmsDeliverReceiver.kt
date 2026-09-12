package com.caconnection.telephony.inbound

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

class SmsDeliverReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_DELIVER_ACTION) return
        val pendingResult = goAsync()
        IncomingSmsProcessor.process(context.applicationContext, intent) {
            pendingResult.finish()
        }
    }
}
