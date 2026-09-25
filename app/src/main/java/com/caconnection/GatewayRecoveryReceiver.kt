package com.caconnection

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Best-effort runtime recovery after events that typically follow a HyperOS
 * process kill: reboot, package update, and user unlock.
 *
 * This is an availability optimization, not the correctness path. Correctness
 * lives in the manifest SMS receivers + durable spool/outbox + WorkManager:
 * Android / HyperOS can kill any process at any time, and as long as
 * SMS_RECEIVED can wake the receiver again, data is recovered from disk.
 * USER_PRESENT is throttled heuristic recovery only — a device that stays
 * locked will not recover the runtime until some other trigger fires.
 *
 * PACKAGE_RESTARTED is deliberately not handled: the broadcast that reports a
 * force-stop is delivered while the package is entering the stopped state, and
 * a stopped package cannot rely on its own manifest receivers to wake itself.
 * It looked like a force-stop recovery hook but never was one.
 */
class GatewayRecoveryReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val applicationContext = context.applicationContext
        val action = intent.action
        if (!shouldRecover(action)) return
        if (isThrottled(applicationContext, action)) return
        Log.i(TAG, "Recovery trigger action=$action")
        GatewayRuntime.reconcile(applicationContext)
    }

    companion object {
        private const val TAG = "GatewayRecovery"
        private const val PREFERENCES = "gateway_recovery"
        private const val KEY_LAST_UNLOCK_RECOVER_AT = "last_unlock_recover_at"
        const val MIN_UNLOCK_RECOVERY_INTERVAL_MS = 5 * 60 * 1_000L

        internal fun shouldRecover(action: String?): Boolean = when (action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            Intent.ACTION_USER_PRESENT -> true
            else -> false
        }

        /**
         * BOOT/PACKAGE_REPLACED always run: they are rare and must recover
         * immediately.  USER_PRESENT is throttled so routine screen unlocks do
         * not re-run the full reconcile every few minutes.
         */
        internal fun isThrottled(action: String?, lastRecoverAt: Long, now: Long): Boolean {
            if (action != Intent.ACTION_USER_PRESENT) return false
            return now - lastRecoverAt < MIN_UNLOCK_RECOVERY_INTERVAL_MS
        }

        private fun isThrottled(context: Context, action: String?): Boolean {
            if (action != Intent.ACTION_USER_PRESENT) return false
            val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            val now = System.currentTimeMillis()
            val last = preferences.getLong(KEY_LAST_UNLOCK_RECOVER_AT, 0L)
            if (isThrottled(action, last, now)) return true
            preferences.edit().putLong(KEY_LAST_UNLOCK_RECOVER_AT, now).apply()
            return false
        }
    }
}
