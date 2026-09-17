package com.caconnection.transport

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.caconnection.worker.OutboxScheduler
import com.caconnection.worker.RemoteCommandScheduler
import java.io.File

class GatewayProvisioningReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != ACTION_IMPORT_PROVISIONING) return
        val provisioning = context.getExternalFilesDir(null)?.let {
            File(it, GatewayProvisioning.FILE_NAME)
        }
        val result = runCatching {
            require(provisioning?.isFile == true) {
                "Provisioning file is missing"
            }
            val document = GatewayProvisioning.parse(
                provisioning.readText(Charsets.UTF_8)
            )
            GatewayTransportConfig.save(
                context = context,
                enabled = document.enabled,
                endpoint = document.endpoint,
                deviceId = document.deviceId,
                replacementSecretBase64 = document.sharedSecretBase64,
                certificatePinSha256Base64 =
                    document.certificatePinSha256Base64.orEmpty()
            )
            OutboxScheduler.enqueueNow(context)
            DeviceStateReporter.enqueue(context)
            RemoteCommandScheduler.enqueueNow(context)
        }
        provisioning?.delete()
        result.onSuccess {
            resultCode = RESULT_PROVISIONED
            resultData = "provisioned"
        }.onFailure {
            resultCode = RESULT_REJECTED
            resultData = "rejected"
        }
    }

    companion object {
        const val ACTION_IMPORT_PROVISIONING =
            "com.caconnection.action.IMPORT_GATEWAY_PROVISIONING"
        const val RESULT_PROVISIONED = 1
        const val RESULT_REJECTED = 2
    }
}
