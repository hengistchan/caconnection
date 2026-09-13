package com.caconnection.telephony.call

import android.app.role.RoleManager
import android.content.Context
import android.content.Intent

class CallScreeningRoleController(private val context: Context) {
    private val roleManager = context.getSystemService(RoleManager::class.java)

    fun isAvailable(): Boolean =
        roleManager.isRoleAvailable(RoleManager.ROLE_CALL_SCREENING)

    fun isRoleHeld(): Boolean =
        isAvailable() && roleManager.isRoleHeld(RoleManager.ROLE_CALL_SCREENING)

    fun createRequestIntent(): Intent? =
        if (isAvailable()) {
            roleManager.createRequestRoleIntent(RoleManager.ROLE_CALL_SCREENING)
        } else {
            null
        }
}
