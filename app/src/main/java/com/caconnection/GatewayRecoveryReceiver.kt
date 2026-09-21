package com.caconnection

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class GatewayRecoveryReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!shouldRecover(intent.action)) return
        GatewayRuntime.reconcile(context)
    }

    companion object {
        fun shouldRecover(action: String?): Boolean =
            action == Intent.ACTION_BOOT_COMPLETED
                || action == Intent.ACTION_MY_PACKAGE_REPLACED
    }
}
