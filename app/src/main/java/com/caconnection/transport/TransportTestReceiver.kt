package com.caconnection.transport

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.caconnection.data.poc.PocEventStore

/**
 * Declared only by the debug manifest and protected by android.permission.DUMP
 * so ADB can queue a deterministic transport acceptance event.
 */
class TransportTestReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != ACTION_QUEUE_TRANSPORT_TEST) return
        val pendingResult = goAsync()
        PocEventStore.get(context).enqueueOutboxSelfTest {
            pendingResult.finish()
        }
    }

    companion object {
        const val ACTION_QUEUE_TRANSPORT_TEST =
            "com.caconnection.action.QUEUE_TRANSPORT_TEST"
    }
}
