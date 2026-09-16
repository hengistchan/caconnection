package com.caconnection.notifications

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import com.caconnection.data.poc.PocEventStore

class GatewayNotificationListenerService : NotificationListenerService() {
    private val lifecycleGate = NotificationLifecycleGate()

    override fun onListenerConnected() {
        super.onListenerConnected()
        Log.i(TAG, "Notification listener connected")
    }

    override fun onListenerDisconnected() {
        Log.w(TAG, "Notification listener disconnected")
        super.onListenerDisconnected()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        capture(sbn, EVENT_POSTED)
    }

    override fun onNotificationRemoved(
        sbn: StatusBarNotification?,
        rankingMap: RankingMap?,
        reason: Int
    ) {
        capture(sbn, EVENT_REMOVED, reason)
    }

    private fun capture(
        sbn: StatusBarNotification?,
        eventType: String,
        removalReason: Int? = null
    ) {
        sbn ?: return
        if (!NotificationAllowlist.isAllowed(this, sbn.packageName)) return
        if (eventType == EVENT_POSTED &&
            !NotificationCapturePolicy.isUserFacing(sbn.notification.flags)
        ) {
            return
        }

        runCatching {
            NotificationEventFactory.create(sbn, eventType, removalReason)
        }.onSuccess { event ->
            val shouldCapture = when (eventType) {
                EVENT_POSTED ->
                    lifecycleGate.shouldCapturePosted(event, event.observedAt)
                EVENT_REMOVED ->
                    lifecycleGate.shouldCaptureRemoved(event, event.observedAt)
                else -> false
            }
            if (shouldCapture) {
                PocEventStore.get(this).insertNotificationWithOutbox(event)
            }
        }.onFailure {
            Log.e(TAG, "Unable to capture allowlisted notification content", it)
        }
    }

    companion object {
        private const val TAG = "GatewayNotification"
        const val EVENT_POSTED = "POSTED"
        const val EVENT_REMOVED = "REMOVED"
    }
}
