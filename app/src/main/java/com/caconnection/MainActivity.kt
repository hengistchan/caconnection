package com.caconnection

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import com.caconnection.data.poc.IncomingSmsEventEntity
import com.caconnection.data.poc.CallEventEntity
import com.caconnection.data.poc.NotificationEventEntity
import com.caconnection.data.poc.OutgoingSmsEventEntity
import com.caconnection.data.poc.PocEventStore
import com.caconnection.data.poc.SubscriptionSnapshotEntity
import com.caconnection.notifications.NotificationAccess
import com.caconnection.notifications.NotificationAllowlist
import com.caconnection.notifications.NotificationHelper
import com.caconnection.telephony.call.CallStateMonitor
import com.caconnection.telephony.diagnostics.GatewayReadinessEvaluator
import com.caconnection.telephony.diagnostics.GatewayReadinessInput
import com.caconnection.telephony.diagnostics.ReadinessSubscription
import com.caconnection.telephony.diagnostics.TelephonyDiagnostics
import com.caconnection.telephony.outbound.SmsGatewaySender
import com.caconnection.telephony.smsrole.SmsRoleController
import com.caconnection.telephony.subscription.SubscriptionRepository
import com.caconnection.telephony.subscription.SubscriptionSnapshot
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : AppCompatActivity() {
    private lateinit var dashboardPage: View
    private lateinit var incomingPage: View
    private lateinit var sendPage: View
    private lateinit var diagnosticsPage: View
    private lateinit var signalsPage: View
    private lateinit var dashboardText: TextView
    private lateinit var incomingText: TextView
    private lateinit var outgoingText: TextView
    private lateinit var diagnosticsText: TextView
    private lateinit var signalsText: TextView
    private lateinit var recipientInput: EditText
    private lateinit var messageInput: EditText
    private lateinit var simSpinner: Spinner
    private lateinit var notificationAllowlistInput: EditText

    private val subscriptionRepository by lazy { SubscriptionRepository(this) }
    private val eventStore by lazy { PocEventStore.get(this) }
    private var activeSubscriptions: List<SubscriptionSnapshot> = emptyList()
    private var receiverRegistered = false

    private val roleLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            refreshAll()
        }

    private val dataChangedReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            refreshStoredEvents()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        NotificationHelper.createChannel(this)
        bindViews()
        bindActions()
        requestPocPermissions()
        applyIntent(intent)
        refreshAll()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        applyIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        if (!receiverRegistered) {
            val filter = IntentFilter(PocEventStore.ACTION_DATA_CHANGED)
            ContextCompat.registerReceiver(
                this,
                dataChangedReceiver,
                filter,
                ContextCompat.RECEIVER_NOT_EXPORTED
            )
            receiverRegistered = true
        }
    }

    override fun onStop() {
        if (receiverRegistered) {
            unregisterReceiver(dataChangedReceiver)
            receiverRegistered = false
        }
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        CallStateMonitor.start(this)
        NotificationAccess.requestRebindIfEnabled(this)
        refreshAll()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_PERMISSIONS) {
            CallStateMonitor.start(this)
            refreshAll()
        }
    }

    private fun bindViews() {
        dashboardPage = findViewById(R.id.page_dashboard)
        incomingPage = findViewById(R.id.page_incoming)
        sendPage = findViewById(R.id.page_send)
        diagnosticsPage = findViewById(R.id.page_diagnostics)
        signalsPage = findViewById(R.id.page_signals)
        dashboardText = findViewById(R.id.dashboard_text)
        incomingText = findViewById(R.id.incoming_text)
        outgoingText = findViewById(R.id.outgoing_text)
        diagnosticsText = findViewById(R.id.diagnostics_text)
        signalsText = findViewById(R.id.signals_text)
        recipientInput = findViewById(R.id.recipient_input)
        messageInput = findViewById(R.id.message_input)
        simSpinner = findViewById(R.id.sim_spinner)
        notificationAllowlistInput = findViewById(R.id.notification_allowlist_input)
        notificationAllowlistInput.setText(
            NotificationAllowlist.get(this).joinToString("\n")
        )
    }

    private fun bindActions() {
        findViewById<Button>(R.id.nav_dashboard).setOnClickListener { showPage(PAGE_DASHBOARD) }
        findViewById<Button>(R.id.nav_incoming).setOnClickListener { showPage(PAGE_INCOMING) }
        findViewById<Button>(R.id.nav_send).setOnClickListener { showPage(PAGE_SEND) }
        findViewById<Button>(R.id.nav_diagnostics).setOnClickListener { showPage(PAGE_DIAGNOSTICS) }
        findViewById<Button>(R.id.nav_signals).setOnClickListener { showPage(PAGE_SIGNALS) }
        findViewById<Button>(R.id.refresh_button).setOnClickListener { refreshAll() }
        findViewById<Button>(R.id.permission_button).setOnClickListener { requestPocPermissions() }
        findViewById<Button>(R.id.role_button).setOnClickListener { requestSmsRole() }
        findViewById<Button>(R.id.battery_button).setOnClickListener { openBatterySettings() }
        findViewById<Button>(R.id.send_button).setOnClickListener { sendSms() }
        findViewById<Button>(R.id.clear_button).setOnClickListener {
            eventStore.clearEvents { runOnUiThread { refreshStoredEvents() } }
        }
        findViewById<Button>(R.id.outbox_test_button).setOnClickListener {
            eventStore.enqueueOutboxSelfTest {
                runOnUiThread {
                    toast("Local Outbox self-test queued")
                    refreshStoredEvents()
                }
            }
        }
        findViewById<Button>(R.id.notification_access_button).setOnClickListener {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
        findViewById<Button>(R.id.save_notification_allowlist_button).setOnClickListener {
            val packages = NotificationAllowlist.set(
                this,
                notificationAllowlistInput.text.toString()
            )
            notificationAllowlistInput.setText(packages.joinToString("\n"))
            NotificationAccess.requestRebindIfEnabled(this)
            toast("Saved ${packages.size} allowed notification source(s)")
            refreshStoredEvents()
        }
    }

    private fun applyIntent(intent: Intent?) {
        intent ?: return
        intent.getStringExtra(EXTRA_RECIPIENT)
            ?.takeIf { it.isNotBlank() }
            ?.let {
                recipientInput.setText(it)
                showPage(PAGE_SEND)
            }
        when (intent.getStringExtra(EXTRA_OPEN_PAGE)) {
            PAGE_DASHBOARD -> showPage(PAGE_DASHBOARD)
            PAGE_INCOMING -> showPage(PAGE_INCOMING)
            PAGE_SEND -> showPage(PAGE_SEND)
            PAGE_DIAGNOSTICS -> showPage(PAGE_DIAGNOSTICS)
            PAGE_SIGNALS -> showPage(PAGE_SIGNALS)
        }
    }

    private fun showPage(page: String) {
        dashboardPage.visibility = if (page == PAGE_DASHBOARD) View.VISIBLE else View.GONE
        incomingPage.visibility = if (page == PAGE_INCOMING) View.VISIBLE else View.GONE
        sendPage.visibility = if (page == PAGE_SEND) View.VISIBLE else View.GONE
        diagnosticsPage.visibility = if (page == PAGE_DIAGNOSTICS) View.VISIBLE else View.GONE
        signalsPage.visibility = if (page == PAGE_SIGNALS) View.VISIBLE else View.GONE
    }

    private fun refreshAll() {
        CallStateMonitor.start(this)
        activeSubscriptions = subscriptionRepository.getActiveSubscriptions()
        updateSimSpinner()
        eventStore.replaceSubscriptions(subscriptionRepository.captureEntities()) {
            runOnUiThread {
                updateDashboard()
                diagnosticsText.text = TelephonyDiagnostics(this).report()
                refreshStoredEvents()
            }
        }
    }

    private fun refreshStoredEvents() {
        eventStore.loadLatest { subscriptions, incoming, outgoing, notifications, calls, outbox ->
            runOnUiThread {
                renderIncoming(incoming)
                renderOutgoing(outgoing)
                renderSignals(notifications, calls)
                updateDashboard(
                    subscriptions,
                    incoming,
                    outgoing,
                    notifications,
                    calls,
                    outbox
                )
                diagnosticsText.text = buildString {
                    append(TelephonyDiagnostics(this@MainActivity).report())
                    appendLine()
                    appendLine("LATEST RAW INBOUND EXTRAS")
                    append(incoming.firstOrNull()?.rawExtras ?: "(no incoming event captured)")
                }
            }
        }
    }

    private fun updateSimSpinner() {
        val labels = if (activeSubscriptions.isEmpty()) {
            listOf("No active subscriptions visible")
        } else {
            activeSubscriptions.map {
                "${it.lineLabel} · subId ${it.subscriptionId} · slot ${it.slotIndex}"
            }
        }
        simSpinner.adapter = ArrayAdapter(
            this,
            android.R.layout.simple_spinner_dropdown_item,
            labels
        )
        simSpinner.isEnabled = activeSubscriptions.isNotEmpty()
    }

    private fun updateDashboard(
        storedSubscriptions: List<SubscriptionSnapshotEntity> = emptyList(),
        incoming: List<IncomingSmsEventEntity> = emptyList(),
        outgoing: List<OutgoingSmsEventEntity> = emptyList(),
        notifications: List<NotificationEventEntity> = emptyList(),
        calls: List<CallEventEntity> = emptyList(),
        outbox: List<com.caconnection.data.poc.OutboxEventEntity> = emptyList()
    ) {
        val roleHeld = SmsRoleController(this).isRoleHeld()
        val receiverGranted = isGranted(Manifest.permission.RECEIVE_SMS)
        val sendGranted = isGranted(Manifest.permission.SEND_SMS)
        val notificationAccess = NotificationAccess.isEnabled(this)
        val notificationAllowlist = NotificationAllowlist.get(this)
        val callMonitor = CallStateMonitor.snapshot()
        val visibleSubscriptions = activeSubscriptions.ifEmpty {
            storedSubscriptions.map {
                SubscriptionSnapshot(
                    it.subscriptionId,
                    it.slotIndex,
                    it.displayName,
                    it.carrierName,
                    it.countryIso,
                    it.embedded,
                    it.opportunistic
                )
            }
        }
        dashboardText.text = buildString {
            val readiness = GatewayReadinessEvaluator.evaluate(
                GatewayReadinessInput(
                    targetSdk = applicationInfo.targetSdkVersion,
                    applicationId = packageName,
                    defaultSmsPackage = android.provider.Telephony.Sms.getDefaultSmsPackage(
                        this@MainActivity
                    ),
                    smsRoleHeld = roleHeld,
                    receiveSmsGranted = receiverGranted,
                    sendSmsGranted = sendGranted,
                    readPhoneStateGranted = isGranted(Manifest.permission.READ_PHONE_STATE),
                    subscriptions = visibleSubscriptions.map {
                        ReadinessSubscription(it.subscriptionId, it.slotIndex)
                    }
                )
            )

            appendLine("DEPLOYMENT SELF-CHECK")
            appendLine("LOCAL STATUS: ${if (readiness.localReady) "READY" else "NOT READY"}")
            readiness.checks.forEach {
                appendLine("${if (it.passed) "[PASS]" else "[FAIL]"} ${it.label}: ${it.detail}")
            }
            appendLine("[CHECK] HyperOS auto-start / MIUIOP(10008): external ADB check")
            appendLine("[CHECK] Notification SMS / MIUIOP(10018): external ADB check")
            appendLine("[ASSUMED] Managed runtime prevents process freeze/kill")
            appendLine()
            incoming.firstOrNull()?.let { latest ->
                appendLine("LAST INBOUND EVIDENCE")
                appendLine("received: ${formatTime(latest.receivedAt)}")
                appendLine(
                    "SIM: slot=${latest.resolvedSlotIndex ?: "?"}, " +
                        "subId=${latest.resolvedSubscriptionId ?: "?"}"
                )
                appendLine(
                    "resolver: ${latest.resolutionMethod} / " +
                        latest.resolutionConfidence
                )
                appendLine("persist delay: ${latest.persistedAt - latest.receivedAt} ms")
                appendLine()
            }

            appendLine("Gateway POC")
            appendLine()
            appendLine("Android ${Build.VERSION.RELEASE} / API ${Build.VERSION.SDK_INT}")
            appendLine(BuildConfig.POC_BUILD)
            appendLine("HyperOS build: ${Build.VERSION.INCREMENTAL}")
            appendLine()
            if (visibleSubscriptions.isEmpty()) {
                appendLine("SIM discovery       WAITING FOR PERMISSION / SIM")
            } else {
                visibleSubscriptions.forEach {
                    appendLine("${it.lineLabel.padEnd(20)} OK")
                    appendLine("  slot=${it.slotIndex}, subId=${it.subscriptionId}")
                }
            }
            appendLine()
            appendLine("Receive permission  ${if (receiverGranted) "OK" else "DENIED"}")
            appendLine("Send permission     ${if (sendGranted) "OK" else "DENIED"}")
            appendLine("Default SMS role    ${if (roleHeld) "YES" else "NO"}")
            appendLine("Notification access ${if (notificationAccess) "YES" else "NO"}")
            appendLine("Allowed notif apps  ${notificationAllowlist.size}")
            appendLine(
                "Call SIM callbacks   " +
                    "${callMonitor.registeredSubscriptions.size}/${visibleSubscriptions.size}"
            )
            if (callMonitor.errors.isNotEmpty()) {
                appendLine("Call callback errors ${callMonitor.errors}")
            }
            appendLine("Incoming captured   ${incoming.size}")
            appendLine("Outgoing attempts   ${outgoing.size}")
            appendLine("Notification events ${notifications.size}")
            appendLine("Call-state events   ${calls.size}")
            appendLine("Outbox events       ${outbox.size}")
            if (outbox.isNotEmpty()) {
                appendLine(
                    "Outbox status       " +
                        outbox.groupingBy { it.status }.eachCount()
                            .entries.joinToString { "${it.key}=${it.value}" }
                )
            }
            appendLine()
            appendLine(
                "Run tools/gateway-readiness.sh for the complete " +
                    "HyperOS READY / NOT READY verdict."
            )
        }
    }

    private fun renderIncoming(events: List<IncomingSmsEventEntity>) {
        incomingText.text = if (events.isEmpty()) {
            "No incoming SMS captured yet."
        } else {
            events.joinToString("\n\n────────────────────────\n\n") { event ->
                buildString {
                    appendLine(formatTime(event.receivedAt))
                    appendLine("From: ${event.originatingAddress.ifBlank { "(unknown)" }}")
                    appendLine("Action: ${event.action.substringAfterLast('.')}")
                    appendLine("Parts: ${event.partCount}")
                    appendLine("SIM: slot=${event.resolvedSlotIndex ?: "?"}, subId=${event.resolvedSubscriptionId ?: "?"}")
                    appendLine("Resolver: ${event.resolutionMethod} / ${event.resolutionConfidence}")
                    appendLine("Notes: ${event.resolutionNotes}")
                    appendLine("Provider: ${event.providerWriteStatus}${event.providerUri?.let { uri -> " · $uri" }.orEmpty()}")
                    event.providerWriteError?.let { appendLine("Provider error: $it") }
                    appendLine()
                    appendLine("Body:")
                    append(event.body)
                }
            }
        }
    }

    private fun renderOutgoing(events: List<OutgoingSmsEventEntity>) {
        outgoingText.text = if (events.isEmpty()) {
            "No outgoing SMS attempts yet."
        } else {
            events.joinToString("\n\n────────────────────────\n\n") { event ->
                buildString {
                    appendLine("${formatTime(event.createdAt)} · ${event.status}")
                    appendLine("To: ${event.recipient}")
                    appendLine("Requested: SIM${event.requestedSlotIndex + 1} subId=${event.requestedSubscriptionId}")
                    appendLine("Carrier: ${event.requestedCarrierName}")
                    appendLine("Parts: ${event.partCount}, sent=${event.sentPartCount}, delivered=${event.deliveredPartCount}, failed=${event.failedPartCount}")
                    event.errorDetail?.let { appendLine("Error: $it") }
                    appendLine("Provider: ${event.providerWriteStatus}${event.providerUri?.let { uri -> " · $uri" }.orEmpty()}")
                    event.providerWriteError?.let { appendLine("Provider error: $it") }
                    appendLine("Body: ${event.body}")
                }
            }
        }
    }

    private fun renderSignals(
        notifications: List<NotificationEventEntity>,
        calls: List<CallEventEntity>
    ) {
        val notificationAccess = NotificationAccess.isEnabled(this)
        val allowlist = NotificationAllowlist.get(this)
        val callMonitor = CallStateMonitor.snapshot()
        signalsText.text = buildString {
            appendLine("NOTIFICATION LISTENER")
            appendLine("Access: ${if (notificationAccess) "GRANTED" else "NOT GRANTED"}")
            appendLine(
                "Allowlist: " +
                    if (allowlist.isEmpty()) "(empty — nothing is captured)"
                    else allowlist.joinToString()
            )
            appendLine("Storage: metadata only; title/body are never persisted")
            appendLine("Captured events: ${notifications.size}")
            notifications.take(10).forEach { event ->
                appendLine(
                    "${formatTime(event.observedAt)} · ${event.eventType} · " +
                        "${event.sourcePackage} · title=${event.titleExposed}" +
                        "(${event.titleLength}) text=${event.textExposed}" +
                        "(${event.textLength})"
                )
            }
            appendLine()
            appendLine("CALL STATE")
            appendLine(
                "READ_PHONE_STATE: " +
                    if (callMonitor.permissionGranted) "GRANTED" else "NOT GRANTED"
            )
            appendLine(
                "Registered subIds: " +
                    if (callMonitor.registeredSubscriptions.isEmpty()) "(none)"
                    else callMonitor.registeredSubscriptions.joinToString()
            )
            appendLine("Caller number: NOT REQUESTED / NOT STORED")
            appendLine("Captured events: ${calls.size}")
            calls.take(20).forEach { event ->
                appendLine(
                    "${formatTime(event.observedAt)} · ${event.state} · " +
                        "SIM${event.slotIndex + 1} / subId ${event.subscriptionId}" +
                        if (event.initialSnapshot) " · initial" else ""
                )
            }
        }
    }

    private fun sendSms() {
        val subscription = activeSubscriptions.getOrNull(simSpinner.selectedItemPosition)
        if (subscription == null) {
            toast("No active SIM is available")
            return
        }
        SmsGatewaySender(this).send(
            recipient = recipientInput.text.toString(),
            body = messageInput.text.toString(),
            subscription = subscription,
            onAccepted = {
                runOnUiThread {
                    toast("SMS dispatch created for ${subscription.lineLabel}")
                    refreshStoredEvents()
                }
            },
            onRejected = { runOnUiThread { toast(it) } }
        )
    }

    private fun requestPocPermissions() {
        val requested = buildList {
            add(Manifest.permission.RECEIVE_SMS)
            add(Manifest.permission.SEND_SMS)
            add(Manifest.permission.READ_PHONE_STATE)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }.filterNot(::isGranted)
        if (requested.isNotEmpty()) {
            requestPermissions(requested.toTypedArray(), REQUEST_PERMISSIONS)
        }
    }

    private fun requestSmsRole() {
        val controller = SmsRoleController(this)
        if (controller.isRoleHeld()) {
            toast("CA Connection is already the default SMS app")
            return
        }
        val requestIntent = controller.createRequestIntent()
        if (requestIntent == null) {
            toast("SMS role is not available on this device")
        } else {
            roleLauncher.launch(requestIntent)
        }
    }

    private fun openBatterySettings() {
        startActivity(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData("package:$packageName".toUri())
        )
    }

    private fun isGranted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun formatTime(time: Long): String =
        SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date(time))

    private fun toast(message: String) =
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()

    companion object {
        const val EXTRA_RECIPIENT = "recipient"
        const val EXTRA_OPEN_PAGE = "open_page"
        const val PAGE_DASHBOARD = "dashboard"
        const val PAGE_INCOMING = "incoming"
        const val PAGE_SEND = "send"
        const val PAGE_DIAGNOSTICS = "diagnostics"
        const val PAGE_SIGNALS = "signals"
        private const val REQUEST_PERMISSIONS = 1001
    }
}
