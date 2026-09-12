package com.caconnection.telephony.subscription

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.telephony.SubscriptionManager
import androidx.core.content.ContextCompat
import com.caconnection.data.poc.SubscriptionSnapshotEntity

class SubscriptionRepository(private val context: Context) {
    fun getActiveSubscriptions(): List<SubscriptionSnapshot> {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return emptyList()
        }

        val manager = context.getSystemService(SubscriptionManager::class.java)
        return runCatching {
            manager.activeSubscriptionInfoList.orEmpty()
                .map {
                    SubscriptionSnapshot(
                        subscriptionId = it.subscriptionId,
                        slotIndex = it.simSlotIndex,
                        displayName = it.displayName?.toString().orEmpty(),
                        carrierName = it.carrierName?.toString().orEmpty(),
                        countryIso = it.countryIso.orEmpty(),
                        isEmbedded = it.isEmbedded,
                        isOpportunistic = it.isOpportunistic
                    )
                }
                .sortedBy { it.slotIndex }
        }.getOrDefault(emptyList())
    }

    fun captureEntities(capturedAt: Long = System.currentTimeMillis()): List<SubscriptionSnapshotEntity> =
        getActiveSubscriptions().map {
            SubscriptionSnapshotEntity(
                capturedAt,
                it.subscriptionId,
                it.slotIndex,
                it.displayName,
                it.carrierName,
                it.countryIso,
                it.isEmbedded,
                it.isOpportunistic
            )
        }

    fun defaultSmsSubscriptionId(): Int = SubscriptionManager.getDefaultSmsSubscriptionId()
}
