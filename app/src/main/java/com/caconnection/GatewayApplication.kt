package com.caconnection

import android.app.Application

class GatewayApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        GatewayRuntime.reconcile(this)
    }
}
