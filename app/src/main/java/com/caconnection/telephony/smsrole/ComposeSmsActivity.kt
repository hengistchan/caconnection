package com.caconnection.telephony.smsrole

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import com.caconnection.MainActivity

class ComposeSmsActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        startActivity(
            Intent(this, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_OPEN_PAGE, MainActivity.PAGE_MESSAGES)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        )
        finish()
    }
}
