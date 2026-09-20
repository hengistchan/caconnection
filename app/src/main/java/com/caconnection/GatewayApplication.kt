package com.caconnection

import android.app.Application
import com.caconnection.notifications.NotificationAllowlist
import com.caconnection.telephony.call.CallStateMonitor
import com.caconnection.telephony.inbound.RuntimeSmsReceiverFallback
import com.caconnection.transport.DeviceStateReporter
import com.caconnection.worker.DeviceStateScheduler
import com.caconnection.worker.OutboxScheduler
import com.caconnection.worker.RemoteCommandScheduler

class GatewayApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // Cancel the pre-0.2.3 non-unique WorkManager backlog, then recover
        // durable rows through the single unique drain.
        OutboxScheduler.reconcileLegacyWork(this)
        NotificationAllowlist.ensureRecommendedDefaults(this)
        DeviceStateReporter.enqueue(this)
        DeviceStateScheduler.schedule(this)
        RemoteCommandScheduler.enqueueNow(this)
        // HyperOS can intermittently skip the manifest SMS_RECEIVED path for
        // non-default SMS apps. Keep an in-process receiver as a second
        // observation path while the managed gateway process is alive.
        RuntimeSmsReceiverFallback.start(this)
        // Callbacks remain runtime registrations. The Phase 3A device test
        // therefore retains the explicit managed-process assumption.
        CallStateMonitor.start(this)
    }
}
