package com.caconnection.notifications

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.caconnection.MainActivity
import com.caconnection.R
import com.caconnection.data.poc.IncomingSmsEventEntity

object NotificationHelper {
    private const val CHANNEL_ID = "incoming_sms_poc"
    private const val CONNECTION_ALERT_CHANNEL_ID = "gateway_connection_alert"
    private const val CONNECTION_ALERT_NOTIFICATION_ID = 1002
    const val FOREGROUND_CHANNEL_ID = "gateway_foreground"

    fun createForegroundChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                FOREGROUND_CHANNEL_ID,
                context.getString(R.string.foreground_channel_name),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = context.getString(R.string.foreground_channel_description)
                setShowBadge(false)
            }
        )
    }

    fun createChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = context.getString(R.string.notification_channel_description)
            }
        )
    }

    fun createConnectionAlertChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CONNECTION_ALERT_CHANNEL_ID,
                context.getString(R.string.connection_alert_channel_name),
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = context.getString(R.string.connection_alert_channel_description)
            }
        )
    }

    fun notifyConnectionAlert(
        context: Context,
        reconnectIntent: PendingIntent,
        openDiagnosticsIntent: PendingIntent
    ) {
        createConnectionAlertChannel(context)
        if (!canPostNotifications(context)) return
        val notification = NotificationCompat.Builder(context, CONNECTION_ALERT_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.connection_alert_title))
            .setContentText(context.getString(R.string.connection_alert_text))
            .setStyle(
                NotificationCompat.BigTextStyle()
                    .bigText(context.getString(R.string.connection_alert_text))
            )
            .setContentIntent(openDiagnosticsIntent)
            .addAction(
                0,
                context.getString(R.string.connection_alert_reconnect),
                reconnectIntent
            )
            .addAction(
                0,
                context.getString(R.string.connection_alert_diagnostics),
                openDiagnosticsIntent
            )
            .setAutoCancel(false)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ERROR)
            .build()
        try {
            NotificationManagerCompat.from(context)
                .notify(CONNECTION_ALERT_NOTIFICATION_ID, notification)
        } catch (_: SecurityException) {
            // Permission can be revoked between the explicit check and notify().
        }
    }

    fun cancelConnectionAlert(context: Context) {
        NotificationManagerCompat.from(context).cancel(CONNECTION_ALERT_NOTIFICATION_ID)
    }

    fun notifyIncoming(context: Context, event: IncomingSmsEventEntity) {
        createChannel(context)
        if (!canPostNotifications(context)) return

        val openIntent = PendingIntent.getActivity(
            context,
            event.eventId.hashCode(),
            Intent(context, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_OPEN_PAGE, MainActivity.PAGE_INCOMING)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val simLabel = event.resolvedSlotIndex?.let { "SIM${it + 1}" } ?: "SIM unresolved"
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("${event.originatingAddress.ifBlank { "Incoming SMS" }} · $simLabel")
            .setContentText(event.body.take(120))
            .setStyle(NotificationCompat.BigTextStyle().bigText(event.body.take(500)))
            .setContentIntent(openIntent)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()

        try {
            NotificationManagerCompat.from(context)
                .notify(event.eventId.hashCode(), notification)
        } catch (_: SecurityException) {
            // Permission can be revoked between the explicit check and notify().
        }
    }

    private fun canPostNotifications(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
}
