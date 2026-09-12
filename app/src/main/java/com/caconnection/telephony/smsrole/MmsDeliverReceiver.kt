package com.caconnection.telephony.smsrole

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log

/**
 * Required for SMS role qualification. MMS is deliberately outside Phase 1;
 * the receiver records no provider data and performs no network work.
 */
class MmsDeliverReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.WAP_PUSH_DELIVER_ACTION) return
        Log.i(TAG, "MMS deliver received but MMS is outside the Phase 1 POC scope")
    }

    companion object {
        private const val TAG = "GatewayMmsReceiver"
    }
}
