package com.caconnection

import android.app.Application
import android.content.Context

object ProcessIdentity {
    fun isMainProcess(context: Context): Boolean =
        processName() == context.packageName

    private fun processName(): String = Application.getProcessName()
}
