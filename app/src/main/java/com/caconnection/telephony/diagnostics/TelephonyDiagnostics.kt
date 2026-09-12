package com.caconnection.telephony.diagnostics

import android.Manifest
import android.app.ActivityManager
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import android.provider.Telephony
import androidx.core.content.ContextCompat
import com.caconnection.BuildConfig
import com.caconnection.telephony.smsrole.SmsRoleController
import com.caconnection.telephony.subscription.SubscriptionRepository

class TelephonyDiagnostics(private val context: Context) {
    fun report(): String {
        val subscriptions = SubscriptionRepository(context)
        val active = subscriptions.getActiveSubscriptions()
        val role = SmsRoleController(context)
        val power = context.getSystemService(PowerManager::class.java)
        val activityManager = context.getSystemService(ActivityManager::class.java)
        val usageStats = context.getSystemService(UsageStatsManager::class.java)
        val batteryExempt = power.isIgnoringBatteryOptimizations(context.packageName)
        val standbyBucket = standbyBucketName(usageStats.appStandbyBucket)

        return buildString {
            appendLine("DEVICE")
            appendLine("manufacturer: ${Build.MANUFACTURER}")
            appendLine("model: ${Build.MODEL}")
            appendLine("product: ${Build.PRODUCT}")
            appendLine("Android: ${Build.VERSION.RELEASE}")
            appendLine("API: ${Build.VERSION.SDK_INT}")
            appendLine("build display: ${Build.DISPLAY}")
            appendLine("incremental: ${Build.VERSION.INCREMENTAL}")
            appendLine()
            appendLine("APP")
            appendLine("applicationId: ${BuildConfig.APPLICATION_ID}")
            appendLine("version: ${BuildConfig.VERSION_NAME}")
            appendLine("build: ${BuildConfig.POC_BUILD}")
            appendLine("targetSdk: ${context.applicationInfo.targetSdkVersion}")
            appendLine("default SMS package: ${Telephony.Sms.getDefaultSmsPackage(context) ?: "(none)"}")
            appendLine("SMS role available: ${role.isRoleAvailable()}")
            appendLine("SMS role held: ${role.isRoleHeld()}")
            appendLine("default SMS subscription: ${subscriptions.defaultSmsSubscriptionId()}")
            appendLine()
            appendLine("PERMISSIONS")
            permissionLines().forEach(::appendLine)
            appendLine("RECEIVE_MMS (role-managed): ${if (isGranted(Manifest.permission.RECEIVE_MMS)) "GRANTED" else "DENIED"}")
            appendLine("RECEIVE_WAP_PUSH (role-managed): ${if (isGranted(Manifest.permission.RECEIVE_WAP_PUSH)) "GRANTED" else "DENIED"}")
            appendLine()
            appendLine("BACKGROUND")
            appendLine("battery optimization exempt: $batteryExempt")
            appendLine("background restricted: ${activityManager.isBackgroundRestricted}")
            appendLine("app standby bucket: $standbyBucket")
            appendLine("HyperOS auto-start / MIUIOP(10008): external ADB check required")
            appendLine("notification SMS / MIUIOP(10018): external ADB check required")
            appendLine("managed process retention: external deployment responsibility")
            appendLine()
            appendLine("ACTIVE SUBSCRIPTIONS (${active.size})")
            if (active.isEmpty()) {
                appendLine("(none visible; grant READ_PHONE_STATE or check SIM state)")
            } else {
                active.forEach {
                    appendLine("SIM${it.slotIndex + 1}")
                    appendLine("  slotIndex: ${it.slotIndex}")
                    appendLine("  subscriptionId: ${it.subscriptionId}")
                    appendLine("  displayName: ${it.displayName}")
                    appendLine("  carrier: ${it.carrierName}")
                    appendLine("  countryIso: ${it.countryIso}")
                    appendLine("  embedded: ${it.isEmbedded}")
                    appendLine("  opportunistic: ${it.isOpportunistic}")
                }
            }
        }
    }

    private fun permissionLines(): List<String> = buildList {
        add(Manifest.permission.RECEIVE_SMS)
        add(Manifest.permission.SEND_SMS)
        add(Manifest.permission.READ_PHONE_STATE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            add(Manifest.permission.POST_NOTIFICATIONS)
        }
    }.map { permission ->
        "${permission.substringAfterLast('.')}: ${if (isGranted(permission)) "GRANTED" else "DENIED"}"
    }

    private fun isGranted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    private fun standbyBucketName(bucket: Int): String = when (bucket) {
        UsageStatsManager.STANDBY_BUCKET_ACTIVE -> "ACTIVE ($bucket)"
        UsageStatsManager.STANDBY_BUCKET_WORKING_SET -> "WORKING_SET ($bucket)"
        UsageStatsManager.STANDBY_BUCKET_FREQUENT -> "FREQUENT ($bucket)"
        UsageStatsManager.STANDBY_BUCKET_RARE -> "RARE ($bucket)"
        UsageStatsManager.STANDBY_BUCKET_RESTRICTED -> "RESTRICTED ($bucket)"
        50 -> "NEVER ($bucket)"
        else -> "UNKNOWN ($bucket)"
    }
}
