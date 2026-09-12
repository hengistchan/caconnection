package com.caconnection.telephony.smsrole

import android.app.role.RoleManager
import android.content.Context
import android.content.Intent

class SmsRoleController(private val context: Context) {
    private val roleManager: RoleManager
        get() = context.getSystemService(RoleManager::class.java)

    fun isRoleAvailable(): Boolean =
        roleManager.isRoleAvailable(RoleManager.ROLE_SMS)

    fun isRoleHeld(): Boolean =
        roleManager.isRoleHeld(RoleManager.ROLE_SMS)

    fun createRequestIntent(): Intent? =
        roleManager
            .takeIf { it.isRoleAvailable(RoleManager.ROLE_SMS) }
            ?.createRequestRoleIntent(RoleManager.ROLE_SMS)
}
