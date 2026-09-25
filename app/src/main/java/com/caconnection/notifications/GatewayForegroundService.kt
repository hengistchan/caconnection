package com.caconnection.notifications

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.caconnection.MainActivity
import com.caconnection.R
import com.caconnection.telephony.inbound.SmsSpoolRecovery
import com.caconnection.transport.CommandStreamClient
import com.caconnection.transport.ConnectionHealth
import com.caconnection.transport.ConnectionStateStore
import com.caconnection.transport.DeviceStateReporter
import com.caconnection.transport.GatewayTransportConfig
import com.caconnection.worker.OutboxScheduler
import com.caconnection.worker.RemoteCommandScheduler
import java.text.DateFormat
import java.util.Date

class GatewayForegroundService : Service() {

    companion object {
        private const val TAG = "GatewayForeground"
        private const val NOTIFICATION_ID = 1001
        private const val ACTION_REFRESH = "com.caconnection.action.REFRESH_GATEWAY_STATUS"
        private const val ACTION_RECOVER = "com.caconnection.action.RECOVER_GATEWAY"

        @Volatile
        private var runningSince = 0L

        /**
         * Whether the availability layer's foreground service is alive right
         * now. The health panel shows this separately on purpose (ADR-003):
         * a dead service degrades latency and visibility, never data safety.
         */
        val isRunning: Boolean
            get() = runningSince > 0L

        fun start(context: Context) {
            start(context, null)
        }

        fun refresh(context: Context) {
            start(context, ACTION_REFRESH)
        }

        fun requestRecovery(context: Context) {
            if (start(context, ACTION_RECOVER)) return
            // Foreground service could not be started (HyperOS kill / background
            // FGS restriction).  The data path must not depend on the service
            // surviving — schedule recovery work directly instead.
            val applicationContext = context.applicationContext
            SmsSpoolRecovery.recover(applicationContext)
            OutboxScheduler.enqueueNow(applicationContext)
            RemoteCommandScheduler.enqueueNow(applicationContext)
        }

        /**
         * @return true when the system accepted the start request.  A return
         * value of false means the caller should fall back to durable
         * WorkManager scheduling.
         */
        private fun start(context: Context, action: String?): Boolean {
            val intent = Intent(context, GatewayForegroundService::class.java)
                .setAction(action)
            return runCatching {
                context.startForegroundService(intent)
                true
            }.getOrElse {
                Log.w(TAG, "Unable to start foreground gateway service", it)
                false
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        runningSince = System.currentTimeMillis()
        NotificationHelper.createForegroundChannel(this)
        startAsForeground()
        ensureCommandStream()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Refresh the notification in case the service was restarted after
        // being killed.  Worker scheduling is handled by GatewayRuntime from
        // Application.onCreate / GatewayRecoveryReceiver — calling reconcile
        // here would re-enter startForegroundService in a loop.
        startAsForeground()
        // Re-checked on every start so a transport settings change picks up
        // a new stream without waiting for a process restart.
        ensureCommandStream()
        if (intent?.action == ACTION_RECOVER) {
            SmsSpoolRecovery.recover(this)
            DeviceStateReporter.enqueue(this)
            OutboxScheduler.enqueueNow(this)
            RemoteCommandScheduler.enqueueNow(this)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        runningSince = 0L
        CommandStreamClient.stop()
        super.onDestroy()
    }

    /**
     * The command stream is pure availability (ADR-003): while it is up it
     * carries command latency and polling relaxes to a reconcile cadence;
     * when it drops, polling snaps back to the fast fallback immediately.
     */
    private fun ensureCommandStream() {
        val settings = GatewayTransportConfig.load(this)
        if (!settings.enabled || !settings.configured) {
            CommandStreamClient.stop()
            return
        }
        CommandStreamClient.start(
            settings = settings,
            onConnectionChanged = { connected ->
                RemoteCommandScheduler.reschedulePolling(
                    this,
                    if (connected) {
                        RemoteCommandScheduler.RECONCILE_POLL_DELAY_MS
                    } else {
                        RemoteCommandScheduler.NORMAL_POLL_DELAY_MS
                    }
                )
                startAsForeground()
            },
            onCommandQueued = {
                // The stream only says work exists; claim/lease stays the
                // single place commands are taken and content leaves.
                RemoteCommandScheduler.nudge(this)
            }
        )
    }

    private fun startAsForeground() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        updateConnectionAlert()
    }

    private fun buildNotification(): Notification {
        val openIntent = openDiagnosticsIntent()
        val reconnectIntent = reconnectIntent()
        val snapshot = ConnectionStateStore.snapshot(this)
        val text = when (snapshot.health) {
            ConnectionHealth.CONNECTED -> snapshot.lastSuccessAt.takeIf { it > 0L }
                ?.let {
                    getString(
                        R.string.foreground_notification_connected,
                        DateFormat.getTimeInstance(DateFormat.MEDIUM).format(Date(it))
                    )
                }
                ?: getString(R.string.foreground_notification_text)
            ConnectionHealth.DEGRADED -> getString(
                R.string.foreground_notification_degraded,
                snapshot.consecutiveFailures
            )
            ConnectionHealth.DISCONNECTED ->
                getString(R.string.foreground_notification_disconnected)
            ConnectionHealth.UNKNOWN -> getString(R.string.foreground_notification_text)
        }
        return NotificationCompat.Builder(this, NotificationHelper.FOREGROUND_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.foreground_notification_title))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(openIntent)
            .addAction(
                0,
                getString(R.string.connection_alert_reconnect),
                reconnectIntent
            )
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }

    private fun updateConnectionAlert() {
        if (ConnectionStateStore.snapshot(this).health == ConnectionHealth.DISCONNECTED) {
            NotificationHelper.notifyConnectionAlert(
                this,
                reconnectIntent(),
                openDiagnosticsIntent()
            )
        } else {
            NotificationHelper.cancelConnectionAlert(this)
        }
    }

    private fun openDiagnosticsIntent(): PendingIntent =
        PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_OPEN_PAGE, MainActivity.PAGE_DIAGNOSTICS)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

    private fun reconnectIntent(): PendingIntent =
        PendingIntent.getService(
            this,
            1,
            Intent(this, GatewayForegroundService::class.java).setAction(ACTION_RECOVER),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
}
