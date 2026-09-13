package com.caconnection.telephony.call

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.telephony.SubscriptionManager
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import com.caconnection.data.poc.CallEventEntity
import com.caconnection.data.poc.PocEventStore
import com.caconnection.telephony.subscription.SubscriptionRepository
import java.util.UUID

data class CallMonitorSnapshot(
    val permissionGranted: Boolean,
    val registeredSubscriptions: Set<Int>,
    val errors: Map<Int, String>
)

object CallStateMonitor {
    private data class Registration(
        val telephonyManager: TelephonyManager,
        val callback: SubscriptionCallCallback
    )

    private val mainHandler = Handler(Looper.getMainLooper())
    private val tracker = CallStateTransitionTracker()
    private val registrations = mutableMapOf<Int, Registration>()
    private val errors = mutableMapOf<Int, String>()
    private var appContext: Context? = null
    private var subscriptionListenerRegistered = false

    @Volatile
    private var currentSnapshot = CallMonitorSnapshot(false, emptySet(), emptyMap())

    private val subscriptionListener =
        object : SubscriptionManager.OnSubscriptionsChangedListener() {
            override fun onSubscriptionsChanged() {
                refreshOnMain()
            }
        }

    fun start(context: Context) {
        appContext = context.applicationContext
        mainHandler.post {
            ensureSubscriptionListener()
            refreshOnMain()
        }
    }

    fun snapshot(): CallMonitorSnapshot = currentSnapshot

    private fun ensureSubscriptionListener() {
        if (subscriptionListenerRegistered) return
        val context = appContext ?: return
        runCatching {
            context.getSystemService(SubscriptionManager::class.java)
                .addOnSubscriptionsChangedListener(context.mainExecutor, subscriptionListener)
        }.onSuccess {
            subscriptionListenerRegistered = true
        }
    }

    @SuppressLint("MissingPermission")
    private fun refreshOnMain() {
        val context = appContext ?: return
        val granted = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.READ_PHONE_STATE
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) {
            unregisterAll()
            currentSnapshot = CallMonitorSnapshot(false, emptySet(), emptyMap())
            return
        }

        val subscriptions = SubscriptionRepository(context).getActiveSubscriptions()
        val currentIds = subscriptions.mapTo(mutableSetOf()) { it.subscriptionId }

        registrations.keys.toList()
            .filterNot(currentIds::contains)
            .forEach(::unregister)

        val baseTelephonyManager = context.getSystemService(TelephonyManager::class.java)
        subscriptions.forEach { subscription ->
            if (registrations.containsKey(subscription.subscriptionId)) return@forEach
            val manager = baseTelephonyManager.createForSubscriptionId(subscription.subscriptionId)
            val callback = SubscriptionCallCallback(
                subscriptionId = subscription.subscriptionId,
                slotIndex = subscription.slotIndex,
                onState = { subscriptionId, slotIndex, state ->
                    tracker.accept(
                        subscriptionId,
                        slotIndex,
                        state,
                        System.currentTimeMillis()
                    )?.let { observation ->
                        PocEventStore.get(context).insertCallWithOutbox(
                            CallEventEntity(
                                UUID.randomUUID().toString(),
                                observation.sessionId,
                                observation.subscriptionId,
                                observation.slotIndex,
                                observation.state,
                                observation.observedAt,
                                observation.initialSnapshot
                            )
                        )
                    }
                }
            )
            runCatching {
                manager.registerTelephonyCallback(context.mainExecutor, callback)
            }.onSuccess {
                registrations[subscription.subscriptionId] = Registration(manager, callback)
                errors.remove(subscription.subscriptionId)
            }.onFailure {
                errors[subscription.subscriptionId] =
                    it.message ?: it.javaClass.simpleName
            }
        }

        currentSnapshot = CallMonitorSnapshot(
            permissionGranted = true,
            registeredSubscriptions = registrations.keys.toSortedSet(),
            errors = errors.toSortedMap()
        )
    }

    private fun unregister(subscriptionId: Int) {
        val registration = registrations.remove(subscriptionId) ?: return
        runCatching {
            registration.telephonyManager.unregisterTelephonyCallback(registration.callback)
        }
        tracker.removeSubscription(subscriptionId)
        errors.remove(subscriptionId)
    }

    private fun unregisterAll() {
        registrations.keys.toList().forEach(::unregister)
    }

    private class SubscriptionCallCallback(
        private val subscriptionId: Int,
        private val slotIndex: Int,
        private val onState: (Int, Int, Int) -> Unit
    ) : TelephonyCallback(), TelephonyCallback.CallStateListener {
        override fun onCallStateChanged(state: Int) {
            onState(subscriptionId, slotIndex, state)
        }
    }
}
