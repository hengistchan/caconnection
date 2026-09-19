package com.caconnection.data.poc

import android.content.Context
import android.content.Intent

/**
 * Keeps the foreground dashboard in sync with durable event changes made by
 * both [PocEventStore] and background workers.
 */
object PocEventChangeNotifier {
    const val ACTION_DATA_CHANGED = "com.caconnection.action.POC_DATA_CHANGED"

    fun notify(context: Context) {
        context.sendBroadcast(
            Intent(ACTION_DATA_CHANGED)
                .setPackage(context.packageName)
        )
    }
}
