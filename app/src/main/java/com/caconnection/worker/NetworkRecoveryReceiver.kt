package com.caconnection.worker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log
import com.caconnection.transport.CommandStreamClient
import com.caconnection.transport.DeviceStateReporter
import com.caconnection.transport.GatewayHealthStore
import com.caconnection.data.poc.PocEventStore

/**
 * Listens for network availability and triggers an immediate Outbox drain
 * when connectivity is restored. Without this, the queue waits for the
 * exponential-backoff timer (up to 5 minutes) even after the network recovers.
 */
object NetworkRecoveryMonitor {
    private const val TAG = "NetworkRecovery"
    private const val RECOVERY_DEBOUNCE_MS = 5_000L
    private var registered = false
    private var callback: ConnectivityManager.NetworkCallback? = null
    private var lastRecoveryAt = 0L

    fun start(context: Context) {
        if (registered) return
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE)
            as? ConnectivityManager ?: return

        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val now = System.currentTimeMillis()
                synchronized(NetworkRecoveryMonitor) {
                    if (now - lastRecoveryAt < RECOVERY_DEBOUNCE_MS) {
                        Log.i(TAG, "Network recovery debounced network=$network")
                        return
                    }
                    lastRecoveryAt = now
                }
                GatewayHealthStore.markNetworkAvailable(context, now)
                Log.i(
                    TAG,
                    "Network available network=$network; recovering transport, outbox, and polling"
                )
                CommandStreamClient.forceReconnect("network_available")
                OutboxScheduler.enqueueRecoveryNow(context, "network_available")
                PocEventStore.get(context)
                    .reconcileUnresolvedIncomingMetadata("network_available")
                RemoteCommandScheduler.enqueueNow(context)
                DeviceStateReporter.enqueue(context)
            }
        }

        runCatching {
            // Follow only the system default network. Listening to every
            // available Wi-Fi/cellular network causes needless reconnects
            // when a secondary transport appears but traffic never moves.
            cm.registerDefaultNetworkCallback(cb)
            callback = cb
            registered = true
        }.onFailure {
            Log.w(TAG, "Unable to register network callback", it)
        }
    }

    fun stop(context: Context) {
        if (!registered) return
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE)
            as? ConnectivityManager ?: return
        callback?.let { runCatching { cm.unregisterNetworkCallback(it) } }
        callback = null
        registered = false
    }
}
