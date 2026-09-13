package com.caconnection.notifications

import android.content.ComponentName
import android.content.Context
import android.service.notification.NotificationListenerService
import androidx.core.app.NotificationManagerCompat

object NotificationAccess {
    fun isEnabled(context: Context): Boolean =
        context.packageName in
            NotificationManagerCompat.getEnabledListenerPackages(context)

    fun requestRebindIfEnabled(context: Context) {
        if (!isEnabled(context)) return
        runCatching {
            NotificationListenerService.requestRebind(
                ComponentName(context, GatewayNotificationListenerService::class.java)
            )
        }
    }
}
