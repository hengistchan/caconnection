package com.caconnection

import android.app.Application
import com.caconnection.worker.OutboxScheduler

class GatewayApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // Recover durable outbox rows after any process restart. A second
        // enqueue after each insert closes the normal insert/schedule window.
        OutboxScheduler.enqueueNow(this)
    }
}
