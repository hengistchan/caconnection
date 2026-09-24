package com.caconnection

import android.content.Context
import com.caconnection.notifications.GatewayForegroundService
import com.caconnection.notifications.NotificationAllowlist
import com.caconnection.telephony.call.CallStateMonitor
import com.caconnection.telephony.inbound.RuntimeSmsReceiverFallback
import com.caconnection.transport.DeviceStateReporter
import com.caconnection.worker.DeviceStateScheduler
import com.caconnection.worker.NetworkRecoveryMonitor
import com.caconnection.worker.OutboxScheduler
import com.caconnection.worker.RemoteCommandScheduler

object GatewayRuntime {
    fun reconcile(context: Context) {
        val applicationContext = context.applicationContext
        GatewayForegroundService.start(applicationContext)
        OutboxScheduler.reconcileLegacyWork(applicationContext)
        NotificationAllowlist.ensureRecommendedDefaults(applicationContext)
        DeviceStateReporter.enqueue(applicationContext)
        DeviceStateScheduler.schedule(applicationContext)
        RemoteCommandScheduler.enqueueNow(applicationContext)
        RuntimeSmsReceiverFallback.start(applicationContext)
        CallStateMonitor.start(applicationContext)
        NetworkRecoveryMonitor.start(applicationContext)
    }
}
