package com.caconnection.telephony.inbound

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import com.caconnection.telephony.smsrole.SmsRoleController

class SmsReceivedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        // A default SMS app receives SMS_DELIVER as the authoritative event. Ignoring
        // SMS_RECEIVED while holding the role prevents duplicate persistence.
        if (SmsRoleController(context).isRoleHeld()) return

        val pendingResult = goAsync()
        IncomingSmsProcessor.process(context.applicationContext, intent) {
            pendingResult.finish()
        }
    }
}
