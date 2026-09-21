package com.caconnection.telephony.inbound

import android.Manifest
import android.content.Context
import android.content.IntentFilter
import android.provider.Telephony
import android.util.Log
import androidx.core.content.ContextCompat

object RuntimeSmsReceiverFallback {
    private const val TAG = "RuntimeSmsFallback"
    private val receiver = SmsReceivedReceiver()

    @Volatile
    private var registered = false

    fun start(context: Context) {
        if (registered) return
        synchronized(this) {
            if (registered) return
            val applicationContext = context.applicationContext
            val filter = IntentFilter(
                Telephony.Sms.Intents.SMS_RECEIVED_ACTION
            ).apply {
                priority = 999
            }
            runCatching {
                ContextCompat.registerReceiver(
                    applicationContext,
                    receiver,
                    filter,
                    Manifest.permission.BROADCAST_SMS,
                    null,
                    ContextCompat.RECEIVER_EXPORTED
                )
            }.onSuccess {
                registered = true
                Log.i(TAG, "Runtime SMS receiver fallback registered")
            }.onFailure {
                Log.e(TAG, "Unable to register runtime SMS receiver fallback", it)
            }
        }
    }
}
