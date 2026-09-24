package com.caconnection.worker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.util.Log

/**
 * Listens for network availability and triggers an immediate Outbox drain
 * when connectivity is restored. Without this, the queue waits for the
 * exponential-backoff timer (up to 5 minutes) even after the network recovers.
 */
object NetworkRecoveryMonitor {
    private const val TAG = "NetworkRecovery"
    private var registered = false
    private var callback: ConnectivityManager.NetworkCallback? = null

    fun start(context: Context) {
        if (registered) return
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE)
            as? ConnectivityManager ?: return

        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()

        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                Log.i(TAG, "Network available — triggering Outbox drain")
                OutboxScheduler.enqueueNow(context)
            }
        }

        runCatching {
            cm.registerNetworkCallback(request, cb)
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
