package com.caconnection

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Rebuilds the gateway runtime after events that typically follow a HyperOS
 * process kill: reboot, package update/restart, and user unlock.
 *
 * USER_PRESENT is the important addition — it fires after the user unlocks the
 * screen, which is the most common moment when a SwipeUpClean-killed gateway
 * can be brought back without the user manually opening the app.
 */
class GatewayRecoveryReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val applicationContext = context.applicationContext
        val action = intent.action
        val restartedPackage = if (action == Intent.ACTION_PACKAGE_RESTARTED) {
            intent.data?.schemeSpecificPart
        } else {
            null
        }
        if (!shouldRecover(action, restartedPackage, context.packageName)) return
        if (isThrottled(applicationContext, action)) return
        Log.i(TAG, "Recovery trigger action=$action")
        GatewayRuntime.reconcile(applicationContext)
    }

    companion object {
        private const val TAG = "GatewayRecovery"
        private const val PREFERENCES = "gateway_recovery"
        private const val KEY_LAST_UNLOCK_RECOVER_AT = "last_unlock_recover_at"
        const val MIN_UNLOCK_RECOVERY_INTERVAL_MS = 5 * 60 * 1_000L

        internal fun shouldRecover(
            action: String?,
            restartedPackage: String?,
            ownPackage: String
        ): Boolean = when (action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            Intent.ACTION_USER_PRESENT -> true
            // Force-stop restarts broadcast the package name in the data URI;
            // ignore restarts of other packages.
            Intent.ACTION_PACKAGE_RESTARTED -> restartedPackage == ownPackage
            else -> false
        }

        /**
         * BOOT/PACKAGE_REPLACED/PACKAGE_RESTARTED always run: they are rare
         * and must recover immediately.  USER_PRESENT is throttled so routine
         * screen unlocks do not re-run the full reconcile every few minutes.
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
