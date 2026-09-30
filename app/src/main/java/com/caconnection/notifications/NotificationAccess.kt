package com.caconnection.notifications

import android.content.ComponentName
import android.content.Context
import android.service.notification.NotificationListenerService
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import com.caconnection.transport.GatewayHealthStore

/**
 * Rebind escalation for a flapping listener. The first disconnect is always
 * worth an immediate attempt; each further attempt without a successful bind
 * backs off further so a bind loop cannot spin.
 */
internal object NotificationRebindPolicy {
    const val SECOND_ATTEMPT_DELAY_MS = 30_000L
    const val THIRD_ATTEMPT_DELAY_MS = 2 * 60_000L
    const val MAX_DELAY_MS = 15 * 60_000L
    const val REQUEST_PENDING_LEASE_MS = 60_000L

    /**
     * How long to wait since the previous request before the next rebind,
     * given how many rebinds were already requested without a reconnect.
     */
    fun delayMs(attempts: Int): Long = when {
        attempts <= 0 -> 0L
        attempts == 1 -> SECOND_ATTEMPT_DELAY_MS
        attempts == 2 -> THIRD_ATTEMPT_DELAY_MS
        else -> MAX_DELAY_MS
    }
}

object NotificationAccess {
    private const val TAG = "NotificationAccess"

    fun isEnabled(context: Context): Boolean =
        context.packageName in
            NotificationManagerCompat.getEnabledListenerPackages(context)

    fun requestRebindIfEnabled(
        context: Context,
        reason: String = "manual",
        now: Long = System.currentTimeMillis()
    ): Boolean {
        if (!isEnabled(context)) {
            Log.w(TAG, "Notification listener rebind skipped reason=$reason access=false")
            return false
        }
        val health = GatewayHealthStore.snapshot(context)
        if (
            health.lastNotificationListenerConnectedAt >
            health.lastNotificationListenerDisconnectedAt
        ) {
            Log.d(TAG, "Notification listener rebind skipped reason=$reason state=connected")
            return false
        }
        if (health.notificationRebindPendingUntil > now) {
            Log.i(
                TAG,
                "Notification listener rebind already pending reason=$reason " +
                    "owner=${health.lastNotificationRebindReason} " +
                    "remainingMs=${health.notificationRebindPendingUntil - now}"
            )
            return false
        }
        val requiredWait = NotificationRebindPolicy.delayMs(health.notificationRebindAttempts)
        if (now - health.lastNotificationRebindRequestedAt < requiredWait) {
            Log.i(
                TAG,
                "Notification listener rebind throttled reason=$reason " +
                    "attempts=${health.notificationRebindAttempts} " +
                    "waitMs=$requiredWait ageMs=${now - health.lastNotificationRebindRequestedAt}"
            )
            return false
        }
        return runCatching {
            NotificationListenerService.requestRebind(
                ComponentName(context, GatewayNotificationListenerService::class.java)
            )
            GatewayHealthStore.markNotificationRebindRequested(
                context = context,
                reason = reason,
                pendingUntil = now + NotificationRebindPolicy.REQUEST_PENDING_LEASE_MS,
                now = now
            )
            Log.i(
                TAG,
                "Notification listener rebind requested reason=$reason " +
                    "attempts=${health.notificationRebindAttempts + 1}"
            )
            true
        }.getOrElse {
            Log.e(TAG, "Notification listener rebind failed reason=$reason", it)
            false
        }
    }
}
