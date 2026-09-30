package com.caconnection

import android.app.Application
import android.util.Log
import com.caconnection.transport.GatewayHealthStore

class GatewayApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        if (ProcessIdentity.isMainProcess(this)) {
            GatewayHealthStore.markProcessStarted(this)
            Log.i("GatewayApplication", "Main gateway process started")
            GatewayRuntime.reconcile(this)
        }
    }
}
