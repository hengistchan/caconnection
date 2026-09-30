package com.caconnection.telephony.inbound

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log
import com.caconnection.telephony.smsrole.SmsRoleController

class SmsReceivedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        // A default SMS app receives SMS_DELIVER as the authoritative event. Ignoring
        // SMS_RECEIVED while holding the role prevents duplicate persistence.
        if (SmsRoleController(context).isRoleHeld()) {
            Log.i(TAG, "Ignoring SMS_RECEIVED because default role uses SMS_DELIVER")
            return
        }

        val pendingResult = goAsync()
        Log.i(TAG, "Accepted SMS_RECEIVED broadcast; starting durable processing")
        IncomingSmsProcessor.process(context.applicationContext, intent) {
            pendingResult.finish()
        }
    }

    companion object {
        private const val TAG = "SmsReceivedReceiver"
    }
}
