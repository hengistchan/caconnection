package com.caconnection.transport

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.caconnection.data.poc.OutboxHelper
import com.caconnection.data.poc.PocEventStore
import com.caconnection.telephony.smsrole.SmsRoleController
import com.caconnection.telephony.subscription.SubscriptionRepository

object DeviceStateReporter {
    fun enqueue(context: Context) {
        val applicationContext = context.applicationContext
        val settings = GatewayTransportConfig.load(applicationContext)
        if (!settings.enabled || !settings.configured) return

        val packageInfo = applicationContext.packageManager.getPackageInfo(
            applicationContext.packageName,
            0
        )
        val roleHeld = SmsRoleController(applicationContext).isRoleHeld()
        val lines = SubscriptionRepository(applicationContext)
            .getActiveSubscriptions()
            .map {
                OutboxHelper.DeviceStateLine(
                    slotIndex = it.slotIndex,
                    subscriptionId = it.subscriptionId,
                    carrierName = it.carrierName.takeIf(String::isNotBlank),
                    displayName = it.displayName.takeIf(String::isNotBlank),
                    active = true
                )
            }
        val payload = OutboxHelper.DeviceStatePayload(
            observedAt = System.currentTimeMillis(),
            appVersion = packageInfo.versionName.orEmpty().ifBlank { "unknown" },
            versionCode = packageInfo.longVersionCode
                .coerceAtMost(Int.MAX_VALUE.toLong())
                .toInt(),
            targetSdk = applicationContext.applicationInfo.targetSdkVersion,
            androidVersion = Build.VERSION.RELEASE.orEmpty().ifBlank {
                Build.VERSION.SDK_INT.toString()
            },
            manufacturer = Build.MANUFACTURER.orEmpty().ifBlank { "unknown" },
            model = Build.MODEL.orEmpty().ifBlank { "unknown" },
            receiveMode = if (roleHeld) "DEFAULT_SMS" else "OBSERVER",
            defaultSmsRole = roleHeld,
            receiveSmsGranted = permissionGranted(
                applicationContext,
                Manifest.permission.RECEIVE_SMS
            ),
            sendSmsGranted = permissionGranted(
                applicationContext,
                Manifest.permission.SEND_SMS
            ),
            readPhoneStateGranted = permissionGranted(
                applicationContext,
                Manifest.permission.READ_PHONE_STATE
            ),
            lines = lines
        )
        PocEventStore.get(applicationContext).enqueueDeviceState(payload)
    }

    private fun permissionGranted(context: Context, permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) ==
            PackageManager.PERMISSION_GRANTED
}
