package com.caconnection

import android.app.Application
import com.caconnection.telephony.call.CallStateMonitor
import com.caconnection.worker.OutboxScheduler
import com.caconnection.worker.RemoteCommandScheduler

class GatewayApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // Recover durable outbox rows after any process restart. A second
        // enqueue after each insert closes the normal insert/schedule window.
        OutboxScheduler.enqueueNow(this)
        RemoteCommandScheduler.enqueueNow(this)
        // Callbacks remain runtime registrations. The Phase 3A device test
        // therefore retains the explicit managed-process assumption.
        CallStateMonitor.start(this)
    }
}
