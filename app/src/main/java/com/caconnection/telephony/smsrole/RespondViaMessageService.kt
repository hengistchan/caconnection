package com.caconnection.telephony.smsrole

import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.telephony.SubscriptionManager
import com.caconnection.telephony.outbound.SmsGatewaySender
import com.caconnection.telephony.subscription.SubscriptionRepository

class RespondViaMessageService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_RESPOND_VIA_MESSAGE) {
            val recipient = intent.data?.schemeSpecificPart?.substringBefore("?").orEmpty()
            val body = intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty()
            val subscriptions = SubscriptionRepository(this).getActiveSubscriptions()
            val defaultSubId = SubscriptionManager.getDefaultSmsSubscriptionId()
            val subscription = subscriptions.firstOrNull { it.subscriptionId == defaultSubId }
                ?: subscriptions.firstOrNull()
            if (recipient.isNotBlank() && body.isNotBlank() && subscription != null) {
                SmsGatewaySender(this).send(
                    recipient,
                    body,
                    subscription,
                    onAccepted = {},
                    onRejected = {}
                )
            }
        }
        stopSelf(startId)
        return START_NOT_STICKY
    }

    companion object {
        private const val ACTION_RESPOND_VIA_MESSAGE = "android.intent.action.RESPOND_VIA_MESSAGE"
    }
}
