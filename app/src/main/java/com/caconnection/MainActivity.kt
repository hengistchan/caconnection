package com.caconnection

import android.Manifest
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.res.ColorStateList
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import androidx.core.os.LocaleListCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import com.caconnection.data.poc.CallEventEntity
import com.caconnection.data.poc.CallIdentityEventEntity
import com.caconnection.data.poc.IncomingSmsEventEntity
import com.caconnection.data.poc.NotificationEventEntity
import com.caconnection.data.poc.OutboxEventEntity
import com.caconnection.data.poc.OutgoingSmsEventEntity
import com.caconnection.data.poc.PocEventStore
import com.caconnection.data.poc.SubscriptionSnapshotEntity
import com.caconnection.notifications.NotificationAccess
import com.caconnection.notifications.NotificationAllowlist
import com.caconnection.notifications.NotificationHelper
import com.caconnection.telephony.call.CallScreeningRoleController
import com.caconnection.telephony.call.CallStateMonitor
import com.caconnection.telephony.diagnostics.TelephonyDiagnostics
import com.caconnection.telephony.smsrole.SmsRoleController
import com.caconnection.telephony.subscription.SubscriptionRepository
import com.caconnection.telephony.subscription.SubscriptionSnapshot
import com.caconnection.transport.GatewayTransportConfig
import com.caconnection.transport.DeviceStateReporter
import com.caconnection.transport.ConnectionDiagnosticReport
import com.caconnection.transport.ConnectionDiagnostics
import com.caconnection.transport.DiagnosticStage
import com.caconnection.transport.GatewayPairing
import com.caconnection.transport.GatewayPairingClaimer
import com.caconnection.transport.GatewayPairingException
import com.caconnection.transport.PairingFailure
import com.caconnection.ui.UiPrivacy
import com.caconnection.worker.OutboxScheduler
import com.caconnection.worker.RemoteCommandScheduler
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.google.android.material.bottomnavigation.BottomNavigationView
import com.google.android.material.button.MaterialButton
import com.google.android.material.card.MaterialCardView
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import java.text.DateFormat
import java.text.NumberFormat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity() {
    private lateinit var homePage: ScrollView
    private lateinit var messagesPage: ScrollView
    private lateinit var activityPage: ScrollView
    private lateinit var settingsPage: ScrollView
    private lateinit var homeContent: LinearLayout
    private lateinit var messagesContent: LinearLayout
    private lateinit var activityContent: LinearLayout
    private lateinit var settingsContent: LinearLayout
    private lateinit var pageTitle: TextView
    private lateinit var pageSubtitle: TextView
    private lateinit var bottomNavigation: BottomNavigationView

    private lateinit var heroTitle: TextView
    private lateinit var heroDetail: TextView
    private lateinit var heroStatus: TextView
    private lateinit var heroDevice: TextView
    private lateinit var heroRefresh: TextView
    private lateinit var heroTransport: TextView
    private lateinit var heroQueue: TextView
    private lateinit var homeMessagesMetric: TextView
    private lateinit var homeNotificationsMetric: TextView
    private lateinit var homeCallsMetric: TextView
    private lateinit var homeQueueMetric: TextView
    private lateinit var simList: LinearLayout
    private lateinit var homeReadinessList: LinearLayout
    private lateinit var homeActivityList: LinearLayout

    private lateinit var incomingMetric: TextView
    private lateinit var outgoingMetric: TextView
    private lateinit var otpMetric: TextView
    private lateinit var messageList: LinearLayout
    private lateinit var messageEmpty: TextView
    private lateinit var logList: LinearLayout
    private lateinit var logEmpty: TextView
    private lateinit var diagnosticsCard: MaterialCardView
    private lateinit var diagnosticsText: TextView
    private lateinit var diagnosticsToggle: MaterialButton

    private lateinit var settingsReadinessList: LinearLayout
    private lateinit var notificationAccessStatus: TextView
    private lateinit var selectedAppName: TextView
    private lateinit var selectAppButton: MaterialButton
    private lateinit var transportStatusTitle: TextView
    private lateinit var transportStatusDetail: TextView
    private lateinit var transportEndpointInput: EditText
    private lateinit var transportDeviceIdInput: EditText
    private lateinit var transportSecretInput: EditText
    private lateinit var transportCertificatePinInput: EditText
    private lateinit var transportEnabledSwitch: MaterialSwitch
    private lateinit var connectionDiagnosticsButton: MaterialButton
    private lateinit var connectionDiagnosticsText: TextView
    private val activityScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private val subscriptionRepository by lazy { SubscriptionRepository(this) }
    private val eventStore by lazy { PocEventStore.get(this) }
    private var activeSubscriptions: List<SubscriptionSnapshot> = emptyList()
    private var storedSubscriptions: List<SubscriptionSnapshotEntity> = emptyList()
    private var incomingEvents: List<IncomingSmsEventEntity> = emptyList()
    private var outgoingEvents: List<OutgoingSmsEventEntity> = emptyList()
    private var notificationEvents: List<NotificationEventEntity> = emptyList()
    private var callEvents: List<CallEventEntity> = emptyList()
    private var callIdentityEvents: List<CallIdentityEventEntity> = emptyList()
    private var outboxEvents: List<OutboxEventEntity> = emptyList()
    private var lastRefreshAt = 0L
    private var currentPage = PAGE_HOME
    private var messageFilter = MessageFilter.ALL
    private var logFilter = LogFilter.ALL
    private var technicalReportVisible = false
    private var lastConnectionDiagnosticReport: ConnectionDiagnosticReport? = null
    private var receiverRegistered = false

    private val roleLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            refreshAll()
        }

    private val callScreeningRoleLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            refreshAll()
        }

    private val qrScanLauncher =
        registerForActivityResult(ScanContract()) { result ->
            result.contents?.let(::claimPairingCode)
        }

    private val cameraPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                launchQrScanner()
            } else {
                toast(R.string.camera_permission_required)
            }
        }

    private val installedAppsPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                showAppSelectionDialog()
            } else {
                toast(R.string.installed_apps_permission_required)
            }
        }

    private val dataChangedReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            refreshStoredEvents()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        applySystemBarInsets()
        NotificationHelper.createChannel(this)
        bindBaseViews()
        buildHomePage()
        buildMessagesPage()
        buildActivityPage()
        buildSettingsPage()
        bindTopLevelActions()
        currentPage = savedInstanceState?.getString(STATE_PAGE) ?: PAGE_HOME
        showPage(currentPage)
        applyIntent(intent)
        refreshAll()

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (currentPage != PAGE_HOME) {
                        bottomNavigation.selectedItemId = R.id.nav_home
                    } else {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            }
        )
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString(STATE_PAGE, currentPage)
        super.onSaveInstanceState(outState)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        applyIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        if (!receiverRegistered) {
            ContextCompat.registerReceiver(
                this,
                dataChangedReceiver,
                IntentFilter(PocEventStore.ACTION_DATA_CHANGED),
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

    override fun onDestroy() {
        activityScope.cancel()
        super.onDestroy()
    }

    override fun onResume() {
        super.onResume()
        CallStateMonitor.start(this)
        NotificationAccess.requestRebindIfEnabled(this)
        if (::homeContent.isInitialized) refreshAll()
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

    private fun bindBaseViews() {
        homePage = findViewById(R.id.page_home)
        messagesPage = findViewById(R.id.page_messages)
        activityPage = findViewById(R.id.page_activity)
        settingsPage = findViewById(R.id.page_settings)
        homeContent = findViewById(R.id.home_content)
        messagesContent = findViewById(R.id.messages_content)
        activityContent = findViewById(R.id.activity_content)
        settingsContent = findViewById(R.id.settings_content)
        pageTitle = findViewById(R.id.page_title)
        pageSubtitle = findViewById(R.id.page_subtitle)
        bottomNavigation = findViewById(R.id.bottom_navigation)
    }

    private fun bindTopLevelActions() {
        bottomNavigation.setOnItemSelectedListener { item ->
            when (item.itemId) {
                R.id.nav_home -> showPage(PAGE_HOME)
                R.id.nav_messages -> showPage(PAGE_MESSAGES)
                R.id.nav_activity -> showPage(PAGE_ACTIVITY)
                R.id.nav_settings -> showPage(PAGE_SETTINGS)
                else -> false
            }
        }
        findViewById<View>(R.id.header_refresh_button).setOnClickListener { view ->
            view.animate().rotationBy(360f).setDuration(450).start()
            refreshAll()
        }
        findViewById<View>(R.id.language_button).setOnClickListener {
            showLanguageDialog()
        }
    }

    private fun buildHomePage() {
        val hero = card(background = R.color.hero_background, radius = 26)
        val heroBody = vertical(padding = 20)
        hero.addView(heroBody)

        val heroHeader = horizontal(gravity = Gravity.CENTER_VERTICAL)
        val mark = TextView(this).apply {
            setText(R.string.brand_initials)
            gravity = Gravity.CENTER
            setTextColor(color(android.R.color.white))
            textSize = 17f
            setTypeface(typeface, Typeface.BOLD)
            background = roundedDrawable(R.color.brand_green, 18)
        }
        heroHeader.addView(mark, linearParams(54, 54))
        val titles = vertical()
        heroTitle = primaryText(getString(R.string.gateway_action_required), 20, true)
        heroDetail = secondaryText(getString(R.string.gateway_action_required_detail, 0), 14)
        titles.addView(heroTitle)
        titles.addView(heroDetail, topMarginParams(2))
        heroHeader.addView(titles, weightedParams(marginStart = 14))
        heroStatus = statusPill(getString(R.string.status_attention), Tone.WARNING)
        heroHeader.addView(heroStatus)
        heroBody.addView(heroHeader)

        val details = vertical()
        heroDevice = addKeyValue(details, getString(R.string.device), "")
        heroRefresh = addKeyValue(details, getString(R.string.last_refresh), "")
        heroTransport = addKeyValue(details, getString(R.string.transport), "")
        heroQueue = addKeyValue(details, getString(R.string.outbox_queue), "")
        heroBody.addView(details, topMarginParams(18))
        homeContent.addView(hero)

        val stats = vertical()
        val contentStats = horizontal()
        val messageStat = statCard(getString(R.string.messages_count))
        homeMessagesMetric = messageStat.second
        contentStats.addView(messageStat.first, weightedParams(marginEnd = 5))
        val notificationStat = statCard(getString(R.string.notifications_count))
        homeNotificationsMetric = notificationStat.second
        contentStats.addView(notificationStat.first, weightedParams(marginStart = 5))
        stats.addView(contentStats)
        val operationalStats = horizontal()
        val callStat = statCard(getString(R.string.calls_count))
        homeCallsMetric = callStat.second
        operationalStats.addView(callStat.first, weightedParams(marginEnd = 5))
        val queueStat = statCard(getString(R.string.pending))
        homeQueueMetric = queueStat.second
        operationalStats.addView(queueStat.first, weightedParams(marginStart = 5))
        stats.addView(operationalStats, topMarginParams(10))
        homeContent.addView(stats, topMarginParams(12))

        homeContent.addView(sectionTitle(getString(R.string.sim_cards)))
        simList = vertical()
        homeContent.addView(simList)

        homeContent.addView(
            sectionHeader(getString(R.string.system_readiness), getString(R.string.review)) {
                bottomNavigation.selectedItemId = R.id.nav_settings
            }
        )
        homeReadinessList = vertical(paddingVertical = 6)
        val readinessCard = card().apply { addView(homeReadinessList) }
        homeContent.addView(readinessCard)

        homeContent.addView(
            sectionHeader(getString(R.string.recent_activity), getString(R.string.view_all)) {
                bottomNavigation.selectedItemId = R.id.nav_activity
            }
        )
        homeActivityList = vertical(paddingVertical = 6)
        homeContent.addView(card().apply { addView(homeActivityList) })
    }

    private fun buildMessagesPage() {
        val metrics = card(background = R.color.hero_background, radius = 22)
        val metricsRow = horizontal(padding = 16)
        val incoming = metric(getString(R.string.incoming))
        incomingMetric = incoming.second
        metricsRow.addView(incoming.first, weightedParams())
        metricsRow.addView(divider(vertical = true))
        val outgoing = metric(getString(R.string.outgoing))
        outgoingMetric = outgoing.second
        metricsRow.addView(outgoing.first, weightedParams())
        metricsRow.addView(divider(vertical = true))
        val otp = metric(getString(R.string.otp_candidates))
        otpMetric = otp.second
        metricsRow.addView(otp.first, weightedParams())
        metrics.addView(metricsRow)
        messagesContent.addView(metrics)

        val filters = ChipGroup(this).apply {
            isSingleSelection = true
            isSelectionRequired = true
        }
        filters.addView(filterChip(R.id.message_filter_all, R.string.all, true))
        filters.addView(filterChip(R.id.message_filter_incoming, R.string.incoming))
        filters.addView(filterChip(R.id.message_filter_outgoing, R.string.outgoing))
        filters.addView(filterChip(R.id.message_filter_otp, R.string.otp_candidates))
        filters.setOnCheckedStateChangeListener { _, checkedIds ->
            val checkedId = checkedIds.firstOrNull() ?: R.id.message_filter_all
            messageFilter = when (checkedId) {
                R.id.message_filter_incoming -> MessageFilter.INCOMING
                R.id.message_filter_outgoing -> MessageFilter.OUTGOING
                R.id.message_filter_otp -> MessageFilter.OTP
                else -> MessageFilter.ALL
            }
            renderMessages()
        }
        messagesContent.addView(filters, topMarginParams(14))
        messageList = vertical()
        messagesContent.addView(messageList, topMarginParams(4))
        messageEmpty = emptyState(getString(R.string.no_messages))
        messagesContent.addView(messageEmpty)
    }

    private fun buildActivityPage() {
        val notice = card(background = R.color.info_background, radius = 18)
        notice.addView(
            secondaryText(getString(R.string.log_privacy_notice), 13).apply {
                setPadding(dp(16), dp(14), dp(16), dp(14))
                setCompoundDrawablesRelativeWithIntrinsicBounds(R.drawable.ic_shield, 0, 0, 0)
                compoundDrawablePadding = dp(10)
            }
        )
        activityContent.addView(notice)

        val filters = ChipGroup(this).apply {
            isSingleSelection = true
            isSelectionRequired = true
        }
        filters.addView(filterChip(R.id.log_filter_all, R.string.all, true))
        filters.addView(filterChip(R.id.log_filter_errors, R.string.errors))
        filters.addView(filterChip(R.id.log_filter_sms, R.string.sms))
        filters.addView(filterChip(R.id.log_filter_calls, R.string.calls))
        filters.addView(filterChip(R.id.log_filter_notifications, R.string.notifications))
        filters.addView(filterChip(R.id.log_filter_transport, R.string.transport))
        filters.setOnCheckedStateChangeListener { _, checkedIds ->
            val checkedId = checkedIds.firstOrNull() ?: R.id.log_filter_all
            logFilter = when (checkedId) {
                R.id.log_filter_errors -> LogFilter.ERRORS
                R.id.log_filter_sms -> LogFilter.SMS
                R.id.log_filter_calls -> LogFilter.CALLS
                R.id.log_filter_notifications -> LogFilter.NOTIFICATIONS
                R.id.log_filter_transport -> LogFilter.TRANSPORT
                else -> LogFilter.ALL
            }
            renderLogs()
        }
        activityContent.addView(filters, topMarginParams(12))
        logList = vertical()
        activityContent.addView(logList, topMarginParams(4))
        logEmpty = emptyState(getString(R.string.no_logs))
        activityContent.addView(logEmpty)

        activityContent.addView(sectionTitle(getString(R.string.debug_tools)))
        val actions = horizontal()
        val copy = outlinedButton(getString(R.string.copy_logs), R.drawable.ic_copy)
        copy.setOnClickListener { copyLogs() }
        actions.addView(copy, weightedParams(marginEnd = 4))
        val share = outlinedButton(getString(R.string.share_logs), R.drawable.ic_share)
        share.setOnClickListener { shareLogs() }
        actions.addView(share, weightedParams(marginStart = 4, marginEnd = 4))
        val clear = outlinedButton(getString(R.string.clear), R.drawable.ic_delete).apply {
            setTextColor(color(R.color.status_error))
            iconTint = ContextCompat.getColorStateList(this@MainActivity, R.color.status_error)
            backgroundTintList = ColorStateList.valueOf(color(R.color.status_error_background))
            strokeColor = ColorStateList.valueOf(color(R.color.status_error))
        }
        clear.setOnClickListener { confirmClearEvents() }
        actions.addView(clear, weightedParams(marginStart = 4))
        activityContent.addView(actions)

        diagnosticsToggle = textButton(getString(R.string.show_technical_report))
        diagnosticsToggle.setOnClickListener {
            technicalReportVisible = !technicalReportVisible
            diagnosticsCard.visibility =
                if (technicalReportVisible) View.VISIBLE else View.GONE
            diagnosticsToggle.setText(
                if (technicalReportVisible) {
                    R.string.hide_technical_report
                } else {
                    R.string.show_technical_report
                }
            )
        }
        activityContent.addView(diagnosticsToggle, topMarginParams(8))
        diagnosticsCard = card(background = R.color.code_background, radius = 18).apply {
            visibility = View.GONE
        }
        diagnosticsText = TextView(this).apply {
            setTextColor(color(R.color.code_text))
            textSize = 12f
            typeface = Typeface.MONOSPACE
            setTextIsSelectable(true)
            setPadding(dp(16), dp(16), dp(16), dp(16))
        }
        diagnosticsCard.addView(diagnosticsText)
        activityContent.addView(diagnosticsCard)
    }

    private fun buildSettingsPage() {
        settingsContent.addView(sectionTitle(getString(R.string.language), first = true))
        val languageCard = actionCard(
            getString(R.string.language),
            currentLanguageLabel(),
            getString(R.string.language_short)
        ) { showLanguageDialog() }
        settingsContent.addView(languageCard)

        settingsContent.addView(sectionTitle(getString(R.string.permissions_and_roles)))
        settingsReadinessList = vertical(paddingVertical = 6)
        settingsContent.addView(card().apply { addView(settingsReadinessList) })
        settingsContent.addView(
            primaryButton(getString(R.string.grant_permissions)).apply {
                setOnClickListener { requestPocPermissions() }
            },
            topMarginParams(10)
        )
        settingsContent.addView(
            outlinedButton(getString(R.string.request_sms_role)).apply {
                setOnClickListener { requestSmsRole() }
            },
            topMarginParams(8)
        )
        settingsContent.addView(
            outlinedButton(getString(R.string.request_call_screening_role)).apply {
                setOnClickListener { requestCallScreeningRole() }
            },
            topMarginParams(8)
        )
        settingsContent.addView(
            textButton(getString(R.string.open_app_settings)).apply {
                setOnClickListener { openBatterySettings() }
            },
            topMarginParams(4)
        )
        // Direct battery-optimization exemption request — the most effective
        // lever against HyperOS / MIUI background throttling.
        val batteryExemptionStatus = secondaryText(
            getString(
                if (isIgnoringBatteryOptimizations()) {
                    R.string.battery_exemption_granted
                } else {
                    R.string.battery_exemption_denied
                }
            ),
            13
        )
        settingsContent.addView(batteryExemptionStatus, topMarginParams(6))
        settingsContent.addView(
            outlinedButton(getString(R.string.request_battery_exemption)).apply {
                setOnClickListener {
                    if (!isIgnoringBatteryOptimizations()) {
                        startActivity(
                            Intent(
                                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                                "package:$packageName".toUri()
                            )
                        )
                    } else {
                        toast(R.string.battery_exemption_granted)
                    }
                }
            },
            topMarginParams(6)
        )

        settingsContent.addView(sectionTitle(getString(R.string.notification_capture)))
        val notificationCard = card(radius = 22)
        val notificationBody = vertical(padding = 18)
        notificationAccessStatus = primaryText("", 17, true)
        notificationBody.addView(notificationAccessStatus)
        notificationBody.addView(
            secondaryText(getString(R.string.notification_privacy_detail), 13),
            topMarginParams(4)
        )
        notificationBody.addView(
            outlinedButton(getString(R.string.open_notification_access)).apply {
                setOnClickListener {
                    startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
                }
            },
            topMarginParams(12)
        )
        // Selected app display
        val selectedAppContainer = horizontal(gravity = Gravity.CENTER_VERTICAL)
        selectedAppName = secondaryText(getString(R.string.no_app_selected), 14)
        selectedAppContainer.addView(selectedAppName, weightedParams())
        notificationBody.addView(selectedAppContainer, topMarginParams(16))
        // Update display with current selection
        updateSelectedAppDisplay()
        selectAppButton = primaryButton(getString(R.string.select_app)).apply {
            setOnClickListener { showAppSelectionDialog() }
        }
        notificationBody.addView(selectAppButton, topMarginParams(10))
        notificationCard.addView(notificationBody)
        settingsContent.addView(notificationCard)

        settingsContent.addView(sectionTitle(getString(R.string.gateway_transport)))
        val transportCard = card(radius = 22)
        val transportBody = vertical(padding = 18)
        val transportHeader = horizontal(gravity = Gravity.CENTER_VERTICAL)
        val transportTitles = vertical()
        transportStatusTitle = primaryText("", 17, true)
        transportStatusDetail = secondaryText("", 13)
        transportTitles.addView(transportStatusTitle)
        transportTitles.addView(transportStatusDetail, topMarginParams(3))
        transportHeader.addView(transportTitles, weightedParams())
        transportEnabledSwitch = MaterialSwitch(this).apply {
            contentDescription = getString(R.string.enable_http_transport)
            showText = false
            textOn = ""
            textOff = ""
        }
        transportHeader.addView(transportEnabledSwitch)
        transportBody.addView(transportHeader)
        transportBody.addView(
            primaryButton(getString(R.string.scan_pairing_qr)).apply {
                setOnClickListener { startQrPairing() }
            },
            topMarginParams(14)
        )
        transportBody.addView(
            textButton(getString(R.string.paste_pairing_code)).apply {
                setOnClickListener { showPairingPasteDialog() }
            },
            topMarginParams(2)
        )

        val endpoint = textField(
            getString(R.string.transport_endpoint_label),
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI,
            helper = getString(R.string.transport_endpoint_helper)
        )
        transportEndpointInput = endpoint.editText
        transportBody.addView(endpoint.layout, topMarginParams(14))
        val deviceId = textField(
            getString(R.string.transport_device_id_label),
            InputType.TYPE_CLASS_TEXT
        )
        transportDeviceIdInput = deviceId.editText
        transportBody.addView(deviceId.layout, topMarginParams(8))
        val secret = textField(
            getString(R.string.transport_secret_label),
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD,
            helper = getString(R.string.transport_secret_helper),
            passwordToggle = true
        )
        transportSecretInput = secret.editText
        transportBody.addView(secret.layout, topMarginParams(8))
        val pin = textField(
            getString(R.string.transport_certificate_pin_label),
            InputType.TYPE_CLASS_TEXT,
            helper = getString(R.string.transport_certificate_pin_helper)
        )
        transportCertificatePinInput = pin.editText
        transportBody.addView(pin.layout, topMarginParams(8))
        transportBody.addView(
            primaryButton(getString(R.string.save_transport)).apply {
                setOnClickListener { saveTransportConfiguration() }
            },
            topMarginParams(12)
        )
        transportBody.addView(
            outlinedButton(getString(R.string.run_transport_self_test)).apply {
                setOnClickListener {
                    eventStore.enqueueOutboxSelfTest {
                        runOnUiThread {
                            toast(R.string.transport_test_queued)
                            refreshStoredEvents()
                        }
                    }
                }
            },
            topMarginParams(8)
        )
        connectionDiagnosticsButton =
            outlinedButton(getString(R.string.run_connection_diagnostics)).apply {
                setOnClickListener { runConnectionDiagnostics() }
            }
        transportBody.addView(connectionDiagnosticsButton, topMarginParams(8))
        connectionDiagnosticsText = TextView(this).apply {
            setTextColor(color(R.color.text_secondary))
            textSize = 12f
            typeface = Typeface.MONOSPACE
            setTextIsSelectable(true)
            visibility = View.GONE
            setPadding(dp(2), dp(10), dp(2), dp(2))
        }
        transportBody.addView(connectionDiagnosticsText)
        transportCard.addView(transportBody)
        settingsContent.addView(transportCard)
        settingsContent.addView(
            textButton(getString(R.string.run_outbox_self_test)).apply {
                setOnClickListener {
                    eventStore.enqueueOutboxSelfTest {
                        runOnUiThread {
                            toast(R.string.outbox_test_queued)
                            refreshStoredEvents()
                        }
                    }
                }
            },
            topMarginParams(6)
        )
        loadTransportInputs()
    }

    private fun applySystemBarInsets() {
        val root = findViewById<View>(R.id.root_layout)
        val start = root.paddingStart
        val top = root.paddingTop
        val end = root.paddingEnd
        val bottom = root.paddingBottom
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val safe = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or
                    WindowInsetsCompat.Type.displayCutout()
            )
            view.updatePadding(
                left = start + safe.left,
                top = top + safe.top,
                right = end + safe.right,
                bottom = bottom + safe.bottom
            )
            insets
        }
        ViewCompat.requestApplyInsets(root)
    }

    private fun applyIntent(intent: Intent?) {
        intent ?: return
        when (intent.getStringExtra(EXTRA_OPEN_PAGE)) {
            PAGE_DASHBOARD, PAGE_HOME -> bottomNavigation.selectedItemId = R.id.nav_home
            PAGE_INCOMING, PAGE_MESSAGES ->
                bottomNavigation.selectedItemId = R.id.nav_messages
            PAGE_DIAGNOSTICS, PAGE_SIGNALS, PAGE_ACTIVITY ->
                bottomNavigation.selectedItemId = R.id.nav_activity
            PAGE_TRANSPORT, PAGE_SETTINGS ->
                bottomNavigation.selectedItemId = R.id.nav_settings
        }
    }

    private fun showPage(page: String): Boolean {
        currentPage = page
        homePage.visibility = if (page == PAGE_HOME) View.VISIBLE else View.GONE
        messagesPage.visibility = if (page == PAGE_MESSAGES) View.VISIBLE else View.GONE
        activityPage.visibility = if (page == PAGE_ACTIVITY) View.VISIBLE else View.GONE
        settingsPage.visibility = if (page == PAGE_SETTINGS) View.VISIBLE else View.GONE
        val (title, subtitle) = when (page) {
            PAGE_MESSAGES -> R.string.messages_title to R.string.messages_subtitle
            PAGE_ACTIVITY -> R.string.activity_title to R.string.activity_subtitle
            PAGE_SETTINGS -> R.string.settings_title to R.string.settings_subtitle
            else -> R.string.home_title to R.string.home_subtitle
        }
        pageTitle.setText(title)
        pageSubtitle.setText(subtitle)
        return true
    }

    private fun refreshAll() {
        CallStateMonitor.start(this)
        activeSubscriptions = runCatching {
            subscriptionRepository.getActiveSubscriptions()
        }.getOrDefault(emptyList())
        lastRefreshAt = System.currentTimeMillis()
        eventStore.replaceSubscriptions(subscriptionRepository.captureEntities()) {
            DeviceStateReporter.enqueue(this)
            refreshStoredEvents()
        }
    }

    private fun refreshStoredEvents() {
        eventStore.loadLatest(
            incomingLimit = 100,
            outgoingLimit = 100,
            notificationLimit = 100,
            callLimit = 100,
            callIdentityLimit = 100,
            outboxLimit = 100
        ) { subscriptions, incoming, outgoing, notifications, calls, identities, outbox ->
            runOnUiThread {
                storedSubscriptions = subscriptions
                incomingEvents = incoming
                outgoingEvents = outgoing
                notificationEvents = notifications
                callEvents = calls
                callIdentityEvents = identities
                outboxEvents = outbox
                renderHome()
                renderMessages()
                renderLogs()
                renderSettings()
                diagnosticsText.text = buildTechnicalReport()
            }
        }
    }

    private fun renderHome() {
        val visibleSubscriptions = visibleSubscriptions()
        val transport = GatewayTransportConfig.load(this)
        val pending = outboxEvents.count { it.status == "PENDING" || it.status == "IN_PROGRESS" }
        val retrying = outboxEvents.count { it.status == "RETRY" }
        val coreChecks = coreReadinessChecks(visibleSubscriptions, transport.enabled && transport.configured)
        val issues = coreChecks.count { !it.passed }
        val ready = issues == 0
        heroTitle.setText(if (ready) R.string.gateway_ready else R.string.gateway_action_required)
        heroDetail.text = if (ready) {
            getString(R.string.gateway_ready_detail)
        } else {
            getString(R.string.gateway_action_required_detail, issues)
        }
        updatePill(
            heroStatus,
            getString(if (ready) R.string.status_ready else R.string.status_attention),
            if (ready) Tone.SUCCESS else Tone.WARNING
        )
        heroDevice.text = getString(
            R.string.device_summary,
            Build.MANUFACTURER,
            Build.MODEL,
            Build.VERSION.RELEASE
        )
        heroRefresh.text =
            if (lastRefreshAt == 0L) getString(R.string.not_available) else relativeTime(lastRefreshAt)
        heroTransport.setText(
            if (transport.enabled && transport.configured) {
                R.string.encrypted_https
            } else {
                R.string.local_mock
            }
        )
        heroQueue.text = if (pending + retrying == 0) {
            getString(R.string.queue_empty)
        } else {
            getString(R.string.queue_count, pending, retrying)
        }
        homeMessagesMetric.text = formatCount(incomingEvents.size + outgoingEvents.size)
        homeNotificationsMetric.text = formatCount(notificationEvents.size)
        homeCallsMetric.text = formatCount(uniqueCallCount())
        homeQueueMetric.text = formatCount(pending + retrying)

        simList.removeAllViews()
        if (visibleSubscriptions.isEmpty()) {
            simList.addView(emptyState(getString(R.string.no_sim_cards), compact = true))
        } else {
            val row = horizontal()
            visibleSubscriptions.sortedBy { it.slotIndex }.forEachIndexed { index, sim ->
                val simCard = card(radius = 20)
                val body = vertical(padding = 16)
                val header = horizontal(gravity = Gravity.CENTER_VERTICAL)
                header.addView(
                    badgeLetter((sim.slotIndex + 1).toString(), if (sim.slotIndex == 0) Tone.BLUE else Tone.PURPLE),
                    linearParams(42, 42)
                )
                val text = vertical()
                text.addView(primaryText(getString(R.string.sim_number, sim.slotIndex + 1), 16, true))
                text.addView(
                    secondaryText(
                        sim.carrierName.ifBlank {
                            sim.displayName.ifBlank { getString(R.string.unknown_carrier) }
                        },
                        13
                    ),
                    topMarginParams(2)
                )
                text.addView(
                    secondaryText(
                        getString(
                            R.string.subscription_detail,
                            sim.subscriptionId,
                            sim.slotIndex
                        ),
                        12
                    ),
                    topMarginParams(2)
                )
                header.addView(text, weightedParams(marginStart = 12))
                body.addView(header)
                simCard.addView(body)
                row.addView(
                    simCard,
                    weightedParams(
                        marginStart = if (index == 0) 0 else 5,
                        marginEnd = if (index == visibleSubscriptions.lastIndex) 0 else 5
                    )
                )
            }
            simList.addView(row)
        }

        homeReadinessList.removeAllViews()
        coreChecks.take(5).forEachIndexed { index, check ->
            homeReadinessList.addView(
                statusRow(check.title, check.detail, check.passed, check.optional)
            )
            if (index != minOf(4, coreChecks.lastIndex)) homeReadinessList.addView(divider())
        }

        homeActivityList.removeAllViews()
        val recent = buildLogEntries().take(5)
        if (recent.isEmpty()) {
            homeActivityList.addView(emptyState(getString(R.string.no_recent_activity), compact = true))
        } else {
            recent.forEachIndexed { index, entry ->
                homeActivityList.addView(compactEventRow(entry))
                if (index != recent.lastIndex) homeActivityList.addView(divider())
            }
        }
    }

    private fun renderMessages() {
        incomingMetric.text = formatCount(incomingEvents.size)
        outgoingMetric.text = formatCount(outgoingEvents.size)
        otpMetric.text = formatCount(incomingEvents.count { extractOtp(it.body) != null })
        messageList.removeAllViews()

        val cards = buildList {
            if (messageFilter == MessageFilter.ALL ||
                messageFilter == MessageFilter.INCOMING ||
                messageFilter == MessageFilter.OTP
            ) {
                incomingEvents
                    .filter { messageFilter != MessageFilter.OTP || extractOtp(it.body) != null }
                    .forEach { add(MessageItem.Incoming(it)) }
            }
            if (messageFilter == MessageFilter.ALL || messageFilter == MessageFilter.OUTGOING) {
                outgoingEvents.forEach { add(MessageItem.Outgoing(it)) }
            }
        }.sortedByDescending(MessageItem::time)
            .take(MAX_VISIBLE_MESSAGES)

        messageEmpty.visibility = if (cards.isEmpty()) View.VISIBLE else View.GONE
        cards.forEach { item ->
            messageList.addView(messageCard(item), topMarginParams(8))
        }
    }

    private fun renderLogs() {
        logList.removeAllViews()
        val entries = buildLogEntries().filter { entry ->
            when (logFilter) {
                LogFilter.ALL -> true
                LogFilter.ERRORS -> entry.tone == Tone.ERROR || entry.tone == Tone.WARNING
                LogFilter.SMS -> entry.category == LogCategory.SMS
                LogFilter.CALLS -> entry.category == LogCategory.CALL
                LogFilter.NOTIFICATIONS -> entry.category == LogCategory.NOTIFICATION
                LogFilter.TRANSPORT -> entry.category == LogCategory.TRANSPORT
            }
        }.take(MAX_VISIBLE_LOGS)
        logEmpty.visibility = if (entries.isEmpty()) View.VISIBLE else View.GONE
        entries.forEach { entry ->
            logList.addView(logCard(entry), topMarginParams(8))
        }
    }

    private fun renderSettings() {
        val visibleSubscriptions = visibleSubscriptions()
        val transport = GatewayTransportConfig.load(this)
        settingsReadinessList.removeAllViews()
        val checks = settingsChecks(visibleSubscriptions, transport.enabled && transport.configured)
        checks.forEachIndexed { index, check ->
            settingsReadinessList.addView(
                statusRow(check.title, check.detail, check.passed, check.optional)
            )
            if (index != checks.lastIndex) settingsReadinessList.addView(divider())
        }
        notificationAccessStatus.setText(
            if (NotificationAccess.isEnabled(this)) {
                R.string.notification_access_enabled
            } else {
                R.string.notification_access_disabled
            }
        )
        if (!transportEndpointInput.hasFocus()) transportEndpointInput.setText(transport.endpoint)
        if (!transportDeviceIdInput.hasFocus()) transportDeviceIdInput.setText(transport.deviceId)
        if (!transportCertificatePinInput.hasFocus()) {
            transportCertificatePinInput.setText(transport.certificatePinSha256Base64)
        }
        transportEnabledSwitch.isChecked = transport.enabled
        val configured = transport.enabled && transport.configured
        transportStatusTitle.setText(
            if (configured) R.string.transport_connected else R.string.transport_not_configured
        )
        transportStatusDetail.setText(
            if (configured) {
                R.string.transport_connected_detail
            } else {
                R.string.transport_not_configured_detail
            }
        )
    }

    private fun coreReadinessChecks(
        subscriptions: List<SubscriptionSnapshot>,
        transportConfigured: Boolean
    ): List<ReadinessUi> = listOf(
        ReadinessUi(
            getString(R.string.target_sdk),
            "targetSdk ${applicationInfo.targetSdkVersion}",
            applicationInfo.targetSdkVersion == 37
        ),
        ReadinessUi(
            getString(R.string.dual_sim),
            getString(R.string.dual_sim_detail, subscriptions.size),
            subscriptions.size == 2 &&
                subscriptions.map { it.slotIndex }.toSet() == setOf(0, 1)
        ),
        permissionCheck(R.string.receive_sms_permission, Manifest.permission.RECEIVE_SMS),
        permissionCheck(R.string.send_sms_permission, Manifest.permission.SEND_SMS),
        ReadinessUi(
            getString(R.string.gateway_transport),
            getString(
                if (transportConfigured) R.string.encrypted_https else R.string.local_mock
            ),
            transportConfigured
        )
    )

    private fun settingsChecks(
        subscriptions: List<SubscriptionSnapshot>,
        transportConfigured: Boolean
    ): List<ReadinessUi> {
        val callSnapshot = CallStateMonitor.snapshot()
        return coreReadinessChecks(subscriptions, transportConfigured) + listOf(
            permissionCheck(R.string.phone_state_permission, Manifest.permission.READ_PHONE_STATE),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                permissionCheck(
                    R.string.notification_permission,
                    Manifest.permission.POST_NOTIFICATIONS,
                    optional = true
                )
            } else {
                ReadinessUi(
                    getString(R.string.notification_permission),
                    getString(R.string.status_granted),
                    true,
                    true
                )
            },
            ReadinessUi(
                getString(R.string.default_sms_role),
                getString(R.string.default_sms_role_detail),
                !SmsRoleController(this).isRoleHeld(),
                true
            ),
            ReadinessUi(
                getString(R.string.notification_access),
                getString(
                    if (NotificationAccess.isEnabled(this)) {
                        R.string.status_enabled
                    } else {
                        R.string.status_disabled
                    }
                ),
                NotificationAccess.isEnabled(this),
                true
            ),
            ReadinessUi(
                getString(R.string.call_screening_role),
                getString(
                    if (CallScreeningRoleController(this).isRoleHeld()) {
                        R.string.status_enabled
                    } else {
                        R.string.status_disabled
                    }
                ),
                CallScreeningRoleController(this).isRoleHeld(),
                true
            ),
            ReadinessUi(
                getString(R.string.call_monitor),
                getString(
                    R.string.registered_count,
                    callSnapshot.registeredSubscriptions.size,
                    subscriptions.size
                ),
                subscriptions.isNotEmpty() &&
                    callSnapshot.registeredSubscriptions.size == subscriptions.size
            )
        )
    }

    private fun permissionCheck(
        label: Int,
        permission: String,
        optional: Boolean = false
    ) = ReadinessUi(
        getString(label),
        getString(if (isGranted(permission)) R.string.status_granted else R.string.status_denied),
        isGranted(permission),
        optional
    )

    private fun buildLogEntries(): List<UiLogEntry> = buildList {
        incomingEvents.forEach { event ->
            add(
                UiLogEntry(
                    time = event.receivedAt,
                    category = LogCategory.SMS,
                    tone = if (event.resolutionConfidence == "HIGH") Tone.SUCCESS else Tone.WARNING,
                    title = getString(R.string.log_incoming_sms),
                    detail = getString(
                        R.string.log_sim_detail,
                        getString(
                            R.string.sim_number,
                            event.resolvedSlotIndex?.plus(1) ?: 0
                        ),
                        event.resolutionMethod,
                        event.resolutionConfidence
                    ),
                    status = event.providerWriteStatus
                )
            )
        }
        outgoingEvents.forEach { event ->
            val tone = when (event.status) {
                "FAILED" -> Tone.ERROR
                "DELIVERED", "SENT_TO_MODEM" -> Tone.SUCCESS
                else -> Tone.BLUE
            }
            add(
                UiLogEntry(
                    time = event.updatedAt,
                    category = LogCategory.SMS,
                    tone = tone,
                    title = getString(R.string.log_outgoing_sms, event.status),
                    detail = getString(
                        R.string.outgoing_metadata,
                        getString(R.string.sim_number, event.requestedSlotIndex + 1),
                        maskAddress(event.recipient),
                        event.sentPartCount,
                        event.partCount
                    ),
                    status = event.status
                )
            )
        }
        notificationEvents.forEach { event ->
            add(
                UiLogEntry(
                    time = event.observedAt,
                    category = LogCategory.NOTIFICATION,
                    tone = Tone.PURPLE,
                    title = getString(R.string.log_notification, event.eventType),
                    detail = getString(
                        R.string.log_notification_detail,
                        event.sourcePackage
                    ),
                    status = event.redactionPolicy
                )
            )
        }
        callEvents.forEach { event ->
            add(
                UiLogEntry(
                    time = event.observedAt,
                    category = LogCategory.CALL,
                    tone = Tone.BLUE,
                    title = getString(R.string.log_call_state, event.state),
                    detail = getString(
                        R.string.log_call_detail,
                        event.slotIndex + 1,
                        event.subscriptionId
                    ),
                    status = event.state
                )
            )
        }
        callIdentityEvents.forEach { event ->
            add(
                UiLogEntry(
                    time = event.observedAt,
                    category = LogCategory.CALL,
                    tone = Tone.SUCCESS,
                    title = getString(R.string.log_caller_identity),
                    detail = "${getString(R.string.sim_number, event.resolvedSlotIndex?.plus(1) ?: 0)} · " +
                        maskAddress(event.callerAddress.orEmpty()),
                    status = event.decision
                )
            )
        }
        outboxEvents.forEach { event ->
            val tone = when (event.status) {
                "FAILED" -> Tone.ERROR
                "RETRY" -> Tone.WARNING
                "SUCCESS" -> Tone.SUCCESS
                else -> Tone.PURPLE
            }
            val error = event.lastError
                ?.let(UiPrivacy::sanitizeDiagnosticText)
                ?.take(80)
                ?.let { getString(R.string.log_error_suffix, it) }
                .orEmpty()
            add(
                UiLogEntry(
                    time = event.updatedAt,
                    category = LogCategory.TRANSPORT,
                    tone = tone,
                    title = getString(R.string.log_outbox, event.status),
                    detail = getString(
                        R.string.log_outbox_detail,
                        event.payloadType ?: "EVENT",
                        event.retryCount,
                        error
                    ),
                    status = event.status
                )
            )
        }
    }.sortedByDescending(UiLogEntry::time)

    private fun buildTechnicalReport(): String = buildString {
        append(TelephonyDiagnostics(this@MainActivity).report())
        appendLine()
        appendLine("TRANSPORT")
        val transport = GatewayTransportConfig.load(this@MainActivity)
        appendLine("enabled: ${transport.enabled}")
        appendLine("configured: ${transport.configured}")
        appendLine("endpoint: ${transport.endpoint.ifBlank { "(none)" }}")
        appendLine("deviceId: ${transport.deviceId.ifBlank { "(none)" }}")
        appendLine("secret: ${if (transport.sharedSecretBase64.isBlank()) "missing" else "configured (hidden)"}")
        appendLine("certificate pin: ${if (transport.certificatePinSha256Base64.isBlank()) "system CA" else "configured (hidden)"}")
        appendLine(
            "notification allowlist: " +
                NotificationAllowlist.get(this@MainActivity).joinToString(",").ifBlank { "(empty)" }
        )
        lastConnectionDiagnosticReport?.let {
            appendLine()
            appendLine("CONNECTION DIAGNOSTICS")
            appendLine(it.sanitizedText())
        }
        appendLine()
        appendLine("EVENT COUNTS")
        appendLine("incoming: ${incomingEvents.size}")
        appendLine("outgoing: ${outgoingEvents.size}")
        appendLine("notifications: ${notificationEvents.size}")
        appendLine("calls: ${callEvents.size}")
        appendLine("caller identities: ${callIdentityEvents.size}")
        appendLine("outbox: ${outboxEvents.size}")
        appendLine()
        appendLine("OUTBOX HEALTH (LATEST ${outboxEvents.size})")
        val statusCounts = outboxEvents.groupingBy { it.status }.eachCount().toSortedMap()
        if (statusCounts.isEmpty()) {
            appendLine("(empty)")
        } else {
            statusCounts.forEach { (status, count) ->
                appendLine("$status: $count")
            }
        }
        val activeOutbox = outboxEvents.filter {
            it.status == "PENDING" || it.status == "IN_PROGRESS" || it.status == "RETRY"
        }
        activeOutbox.minByOrNull { it.createdAt }?.let {
            appendLine(
                "oldest active age seconds: " +
                    ((System.currentTimeMillis() - it.createdAt).coerceAtLeast(0L) / 1_000L)
            )
        }
        activeOutbox.mapNotNull { it.nextRetryAt.takeIf { retryAt -> retryAt > 0L } }
            .minOrNull()
            ?.let { appendLine("next retry at: $it") }
        outboxEvents.firstOrNull { !it.lastError.isNullOrBlank() }?.lastError
            ?.let(UiPrivacy::sanitizeDiagnosticText)
            ?.take(160)
            ?.let { appendLine("latest error: $it") }
        incomingEvents.firstOrNull()?.let {
            appendLine()
            appendLine("LATEST RAW INBOUND EXTRAS")
            append(it.rawExtras.ifBlank { "(none)" })
        }
    }

    private fun uniqueCallCount(): Int {
        val sessionCount = callEvents.map { it.sessionId }.distinct().size
        val unmatchedIdentities = callIdentityEvents.count { identity ->
            callEvents.none { call ->
                val sameSlot = identity.resolvedSlotIndex == null ||
                    identity.resolvedSlotIndex == call.slotIndex
                sameSlot && kotlin.math.abs(identity.observedAt - call.observedAt) <= 10_000L
            }
        }
        return sessionCount + unmatchedIdentities
    }

    private fun buildSanitizedLogs(): String = buildString {
        appendLine(getString(R.string.sanitized_log_header))
        appendLine(getString(R.string.generated_at, formatTime(System.currentTimeMillis())))
        appendLine("app=${BuildConfig.APPLICATION_ID} version=${BuildConfig.VERSION_NAME}")
        appendLine("device=${Build.MANUFACTURER} ${Build.MODEL} Android=${Build.VERSION.RELEASE}")
        appendLine("targetSdk=${applicationInfo.targetSdkVersion}")
        appendLine("transportConfigured=${GatewayTransportConfig.load(this@MainActivity).configured}")
        appendLine("notificationAccess=${NotificationAccess.isEnabled(this@MainActivity)}")
        lastConnectionDiagnosticReport?.let {
            appendLine()
            appendLine("CONNECTION DIAGNOSTICS")
            appendLine(it.sanitizedText())
        }
        appendLine()
        buildLogEntries().forEach { entry ->
            appendLine(
                "${formatTime(entry.time)} [${entry.category}] [${entry.status}] " +
                    "${entry.title} — ${entry.detail}"
            )
        }
    }

    private fun messageCard(item: MessageItem): MaterialCardView {
        val card = card(radius = 20)
        val body = vertical(padding = 16)
        val header = horizontal(gravity = Gravity.CENTER_VERTICAL)
        val incoming = item is MessageItem.Incoming
        header.addView(
            badgeLetter(if (incoming) "↓" else "↑", if (incoming) Tone.SUCCESS else Tone.BLUE),
            linearParams(42, 42)
        )
        val text = vertical()
        val title: String
        val metadata: String
        val content: String
        val otp: String?
        if (item is MessageItem.Incoming) {
            val event = item.event
            title = getString(
                R.string.from_sender,
                event.originatingAddress.ifBlank { getString(R.string.unknown_sender) }
            )
            metadata = getString(
                R.string.message_metadata,
                getString(R.string.sim_number, event.resolvedSlotIndex?.plus(1) ?: 0),
                relativeTime(event.receivedAt),
                event.partCount
            )
            content = event.body
            otp = extractOtp(event.body)
        } else {
            val event = (item as MessageItem.Outgoing).event
            title = getString(R.string.to_recipient, event.recipient)
            metadata = getString(
                R.string.outgoing_metadata,
                getString(R.string.sim_number, event.requestedSlotIndex + 1),
                relativeTime(event.updatedAt),
                event.sentPartCount,
                event.partCount
            )
            content = event.body
            otp = null
        }
        text.addView(primaryText(title, 16, true))
        text.addView(secondaryText(metadata, 12), topMarginParams(2))
        header.addView(text, weightedParams(marginStart = 12))
        val status = if (item is MessageItem.Incoming) {
            item.event.resolutionConfidence
        } else {
            (item as MessageItem.Outgoing).event.status
        }
        header.addView(
            statusPill(
                status,
                when (status) {
                    "FAILED", "LOW" -> Tone.ERROR
                    "DELIVERED", "SENT_TO_MODEM", "HIGH" -> Tone.SUCCESS
                    else -> Tone.BLUE
                }
            )
        )
        body.addView(header)
        body.addView(
            secondaryText(content, 14).apply {
                maxLines = 3
                ellipsize = TextUtils.TruncateAt.END
            },
            topMarginParams(10)
        )
        otp?.let { code ->
            val otpRow = horizontal(gravity = Gravity.CENTER_VERTICAL)
            otpRow.addView(
                statusPill(getString(R.string.otp_candidate, code), Tone.SUCCESS),
                weightedParams()
            )
            val copy = textButton(getString(R.string.copy_code)).apply {
                setOnClickListener { copyCode(code) }
            }
            otpRow.addView(copy)
            body.addView(otpRow, topMarginParams(8))
        }
        card.addView(body)
        card.isClickable = true
        card.isFocusable = true
        card.setOnClickListener {
            MaterialAlertDialogBuilder(this)
                .setTitle(title)
                .setMessage("$content\n\n$metadata")
                .setPositiveButton(android.R.string.ok, null)
                .apply {
                    otp?.let { code ->
                        setNeutralButton(R.string.copy_code) { _, _ -> copyCode(code) }
                    }
                }
                .show()
        }
        return card
    }

    private fun compactEventRow(entry: UiLogEntry): View {
        val row = horizontal(gravity = Gravity.CENTER_VERTICAL, paddingHorizontal = 14, paddingVertical = 10)
        row.addView(
            badgeLetter(categoryLetter(entry.category), entry.tone),
            linearParams(38, 38)
        )
        val text = vertical()
        text.addView(primaryText(entry.title, 15, true))
        text.addView(
            secondaryText(entry.detail, 12).apply {
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
            },
            topMarginParams(2)
        )
        row.addView(text, weightedParams(marginStart = 11))
        row.addView(secondaryText(relativeTime(entry.time), 12))
        return row
    }

    private fun logCard(entry: UiLogEntry): MaterialCardView {
        val card = card(radius = 18)
        val row = horizontal(gravity = Gravity.TOP, padding = 15)
        row.addView(
            badgeLetter(categoryLetter(entry.category), entry.tone),
            linearParams(40, 40)
        )
        val text = vertical()
        val titleRow = horizontal(gravity = Gravity.CENTER_VERTICAL)
        titleRow.addView(primaryText(entry.title, 15, true), weightedParams())
        titleRow.addView(statusPill(entry.status, entry.tone))
        text.addView(titleRow)
        text.addView(secondaryText(entry.detail, 13), topMarginParams(5))
        text.addView(secondaryText(formatTime(entry.time), 11), topMarginParams(7))
        row.addView(text, weightedParams(marginStart = 12))
        card.addView(row)
        return card
    }

    private fun statusRow(
        title: String,
        detail: String,
        passed: Boolean,
        optional: Boolean
    ): View {
        val row = horizontal(
            gravity = Gravity.CENTER_VERTICAL,
            paddingHorizontal = 16,
            paddingVertical = 11
        )
        val dot = TextView(this).apply {
            text = if (passed) "✓" else if (optional) "○" else "!"
            gravity = Gravity.CENTER
            setTextColor(
                color(
                    when {
                        passed -> R.color.status_success
                        optional -> R.color.text_secondary
                        else -> R.color.status_error
                    }
                )
            )
            setTypeface(typeface, Typeface.BOLD)
        }
        row.addView(dot, linearParams(30, 30))
        val texts = vertical()
        texts.addView(primaryText(title, 14, true))
        texts.addView(secondaryText(detail, 12), topMarginParams(2))
        row.addView(texts, weightedParams(marginStart = 8))
        row.addView(
            statusPill(
                getString(
                    when {
                        passed -> R.string.status_ready
                        optional -> R.string.status_optional
                        else -> R.string.status_attention
                    }
                ),
                when {
                    passed -> Tone.SUCCESS
                    optional -> Tone.NEUTRAL
                    else -> Tone.ERROR
                }
            )
        )
        return row
    }

    private fun updateSelectedAppDisplay() {
        val allowedPackages = NotificationAllowlist.get(this)
        if (allowedPackages.isEmpty()) {
            selectedAppName.text = getString(R.string.no_app_selected)
        } else if (allowedPackages.size == 1) {
            val packageName = allowedPackages.first()
            val appName = getAppName(packageName)
            selectedAppName.text = "$appName\n$packageName"
        } else {
            selectedAppName.text = getString(R.string.apps_selected, allowedPackages.size)
        }
    }

    private fun getAppName(packageName: String): String {
        return try {
            val appInfo = packageManager.getApplicationInfo(packageName, 0)
            packageManager.getApplicationLabel(appInfo).toString()
        } catch (e: Exception) {
            packageName
        }
    }

    private fun showAppSelectionDialog() {
        // Check GET_INSTALLED_APPS permission first (required for MIUI/HyperOS)
        val permission = "com.android.permission.GET_INSTALLED_APPS"
        try {
            val permissionInfo = packageManager.getPermissionInfo(permission, 0)
            if (permissionInfo != null &&
                permissionInfo.packageName == "com.lbe.security.miui" &&
                ContextCompat.checkSelfPermission(this, permission) != PackageManager.PERMISSION_GRANTED
            ) {
                // Need to request permission on MIUI/HyperOS
                installedAppsPermissionLauncher.launch(permission)
                return
            }
        } catch (_: Exception) {
            // Permission doesn't exist, proceed normally
        }

        // Show loading state
        selectAppButton.isEnabled = false
        selectAppButton.text = getString(R.string.loading_apps)

        activityScope.launch {
            val allApps = withContext(Dispatchers.IO) {
                getInstalledApps()
            }

            // Restore button state
            selectAppButton.isEnabled = true
            selectAppButton.text = getString(R.string.select_app)

            if (allApps.isEmpty()) {
                toast(R.string.no_apps_found)
                return@launch
            }

            showAppSelectionDialogWithApps(allApps)
        }
    }

    private fun showAppSelectionDialogWithApps(allApps: List<AppInfo>) {
        val currentAllowed = NotificationAllowlist.get(this)
        val selectedPackages = allApps
            .filter { it.packageName in currentAllowed }
            .map { it.packageName }
            .toMutableSet()

        // Split into user and system apps
        val userApps = allApps.filter { it.isUserApp }
        val systemApps = allApps.filter { !it.isUserApp }

        // Create dialog with custom layout
        val dialogView = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val dp16 = dp(16)
            setPadding(dp16, dp16, dp16, 0)
        }

        // Search input
        val searchInput = EditText(this).apply {
            hint = getString(R.string.search_apps)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_NORMAL
            setPadding(dp(12), dp(12), dp(12), dp(12))
            val params = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            params.bottomMargin = dp(12)
            layoutParams = params
        }
        dialogView.addView(searchInput)

        // ScrollView with CheckBox list
        val scrollView = ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        }

        val listContainer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }

        // Store all checkbox views for filtering
        data class AppCheckBox(
            val checkBox: android.widget.CheckBox,
            val sectionHeader: TextView?,
            val appInfo: AppInfo
        )
        val appCheckBoxes = mutableListOf<AppCheckBox>()

        fun addSectionHeader(title: String): TextView {
            val header = TextView(this@MainActivity).apply {
                text = title
                textSize = 14f
                setTextColor(color(R.color.brand_blue))
                setPadding(0, dp(8), 0, dp(4))
                setTypeface(null, Typeface.BOLD)
            }
            listContainer.addView(header)
            return header
        }

        fun addAppCheckBox(app: AppInfo, header: TextView?) {
            val checkBox = android.widget.CheckBox(this@MainActivity).apply {
                text = "${app.appName}\n${app.packageName}"
                textSize = 13f
                isChecked = app.packageName in selectedPackages
                setPadding(dp(8), dp(4), dp(8), dp(4))
                setOnCheckedChangeListener { _, isChecked ->
                    if (isChecked) {
                        selectedPackages.add(app.packageName)
                    } else {
                        selectedPackages.remove(app.packageName)
                    }
                }
            }
            listContainer.addView(checkBox)
            appCheckBoxes.add(AppCheckBox(checkBox, header, app))
        }

        // Add user apps section
        val userHeader = if (userApps.isNotEmpty()) {
            addSectionHeader(getString(R.string.user_apps))
        } else null
        userApps.forEach { addAppCheckBox(it, userHeader) }

        // Add system apps section
        val systemHeader = if (systemApps.isNotEmpty()) {
            addSectionHeader(getString(R.string.system_apps))
        } else null
        systemApps.forEach { addAppCheckBox(it, systemHeader) }

        scrollView.addView(listContainer)
        dialogView.addView(scrollView)

        // Search filter
        searchInput.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: android.text.Editable?) {
                val query = s?.toString()?.lowercase() ?: ""
                var hasVisibleUserApps = false
                var hasVisibleSystemApps = false

                appCheckBoxes.forEach { item ->
                    val matches = query.isEmpty() ||
                        item.appInfo.appName.lowercase().contains(query) ||
                        item.appInfo.packageName.lowercase().contains(query)
                    item.checkBox.visibility = if (matches) View.VISIBLE else View.GONE

                    if (matches) {
                        if (item.appInfo.isUserApp) hasVisibleUserApps = true
                        else hasVisibleSystemApps = true
                    }
                }

                userHeader?.visibility = if (hasVisibleUserApps) View.VISIBLE else View.GONE
                systemHeader?.visibility = if (hasVisibleSystemApps) View.VISIBLE else View.GONE
            }
        })

        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.select_app)
            .setView(dialogView)
            .setPositiveButton(R.string.confirm) { dialog, _ ->
                NotificationAllowlist.set(this, selectedPackages.joinToString(","))
                updateSelectedAppDisplay()
                NotificationAccess.requestRebindIfEnabled(this)
                toast(getString(R.string.allowlist_saved, selectedPackages.size))
                refreshStoredEvents()
                dialog.dismiss()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun isSystemPackage(appInfo: android.content.pm.ApplicationInfo): Boolean {
        // Check if installed in system partition
        val sourceDir = appInfo.sourceDir ?: return false
        if (sourceDir.startsWith("/system/") || sourceDir.startsWith("/vendor/") ||
            sourceDir.startsWith("/product/") || sourceDir.startsWith("/oem/")) {
            return true
        }
        // Check FLAG_SYSTEM but not FLAG_UPDATED_SYSTEM_APP
        val isSystem = (appInfo.flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0
        val isUpdated = (appInfo.flags and android.content.pm.ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0
        // Log for debugging
        android.util.Log.d("AppFilter", "sourceDir=$sourceDir, isSystem=$isSystem, isUpdated=$isUpdated, flags=${appInfo.flags}")
        return isSystem && !isUpdated
    }

    private fun getInstalledApps(): List<AppInfo> {
        // Get all installed packages
        val packages = packageManager.getInstalledPackages(0)
        android.util.Log.d("AppFilter", "Total packages: ${packages.size}")

        val apps = packages
            .asSequence()
            .filter { it.packageName != packageName }
            .mapNotNull { packageInfo ->
                val appPackageName = packageInfo.packageName
                val appInfo = packageInfo.applicationInfo ?: return@mapNotNull null
                val appName = packageManager.getApplicationLabel(appInfo).toString()
                val icon = try {
                    packageManager.getApplicationIcon(appInfo)
                } catch (e: Exception) {
                    null
                }
                val isUserApp = !isSystemPackage(appInfo)
                AppInfo(appPackageName, appName, icon, isUserApp)
            }
            .distinctBy { it.packageName }
            .sortedWith(compareBy<AppInfo> { !it.isUserApp }.thenBy { it.appName.lowercase() })
            .toList()

        android.util.Log.d("AppFilter", "User apps: ${apps.count { it.isUserApp }}, System apps: ${apps.count { !it.isUserApp }}")
        return apps
    }

    private data class AppInfo(
        val packageName: String,
        val appName: String,
        val icon: android.graphics.drawable.Drawable?,
        val isUserApp: Boolean = true
    )

    private fun saveTransportConfiguration() {
        runCatching {
            GatewayTransportConfig.save(
                context = this,
                enabled = transportEnabledSwitch.isChecked,
                endpoint = transportEndpointInput.text.toString(),
                deviceId = transportDeviceIdInput.text.toString(),
                replacementSecretBase64 =
                    transportSecretInput.text.toString().takeIf(String::isNotBlank),
                certificatePinSha256Base64 =
                    transportCertificatePinInput.text.toString()
            )
        }.onSuccess {
            transportSecretInput.text.clear()
            OutboxScheduler.enqueueNow(this)
            RemoteCommandScheduler.enqueueNow(this)
            DeviceStateReporter.enqueue(this)
            toast(R.string.transport_saved)
            refreshStoredEvents()
        }.onFailure {
            toast(it.message ?: getString(R.string.invalid_transport))
        }
    }

    private fun startQrPairing() {
        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
            showPairingPasteDialog()
            return
        }
        if (
            ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            launchQrScanner()
        } else {
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    private fun launchQrScanner() {
        qrScanLauncher.launch(
            ScanOptions()
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt(getString(R.string.scan_pairing_prompt))
                .setBeepEnabled(false)
                .setOrientationLocked(false)
        )
    }

    private fun showPairingPasteDialog() {
        val input = TextInputEditText(this).apply {
            hint = getString(R.string.pairing_code_hint)
            minLines = 4
            maxLines = 8
            isVerticalScrollBarEnabled = false
            inputType =
                InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
        }
        val container = TextInputLayout(this).apply {
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
            setPadding(dp(20), dp(4), dp(20), 0)
            addView(
                input,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                )
            )
        }
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.paste_pairing_code)
            .setMessage(R.string.paste_pairing_code_detail)
            .setView(container)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.connect) { _, _ ->
                claimPairingCode(input.text?.toString().orEmpty())
            }
            .show()
    }

    private fun claimPairingCode(raw: String) {
        val document = runCatching { GatewayPairing.parse(raw.trim()) }
            .getOrElse {
                toast(R.string.pairing_invalid)
                return
            }
        transportStatusTitle.setText(R.string.pairing_connecting)
        transportStatusDetail.setText(R.string.pairing_connecting_detail)
        activityScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching { GatewayPairingClaimer().claim(document) }
            }
            result.onSuccess { provisioning ->
                GatewayTransportConfig.save(
                    context = this@MainActivity,
                    enabled = provisioning.enabled,
                    endpoint = provisioning.endpoint,
                    deviceId = provisioning.deviceId,
                    replacementSecretBase64 = provisioning.sharedSecretBase64,
                    certificatePinSha256Base64 =
                        provisioning.certificatePinSha256Base64.orEmpty()
                )
                loadTransportInputs()
                OutboxScheduler.enqueueNow(this@MainActivity)
                DeviceStateReporter.enqueue(this@MainActivity)
                toast(R.string.pairing_success)
                refreshStoredEvents()
                runConnectionDiagnostics()
            }.onFailure { error ->
                val message = when ((error as? GatewayPairingException)?.failure) {
                    PairingFailure.EXPIRED_OR_USED -> R.string.pairing_expired
                    PairingFailure.TLS -> R.string.pairing_tls_error
                    PairingFailure.NETWORK -> R.string.pairing_network_error
                    PairingFailure.SERVER -> R.string.pairing_server_error
                    else -> R.string.pairing_invalid
                }
                toast(message)
                renderSettings()
            }
        }
    }

    private fun runConnectionDiagnostics() {
        val settings = GatewayTransportConfig.load(this)
        connectionDiagnosticsButton.isEnabled = false
        connectionDiagnosticsText.visibility = View.VISIBLE
        connectionDiagnosticsText.setText(R.string.connection_diagnostics_running)
        activityScope.launch {
            val report = withContext(Dispatchers.IO) {
                ConnectionDiagnostics().run(settings)
            }
            lastConnectionDiagnosticReport = report
            connectionDiagnosticsText.text = formatDiagnosticReport(report)
            diagnosticsText.text = buildTechnicalReport()
            connectionDiagnosticsButton.isEnabled = true
            toast(
                if (report.passed) {
                    R.string.connection_diagnostics_passed
                } else {
                    R.string.connection_diagnostics_failed
                }
            )
        }
    }

    private fun formatDiagnosticReport(report: ConnectionDiagnosticReport): String =
        buildString {
            report.steps.forEach { step ->
                val stage = when (step.stage) {
                    DiagnosticStage.CONFIGURATION -> R.string.diagnostic_configuration
                    DiagnosticStage.DNS -> R.string.diagnostic_dns
                    DiagnosticStage.TCP -> R.string.diagnostic_tcp
                    DiagnosticStage.TLS -> R.string.diagnostic_tls
                    DiagnosticStage.HEALTH -> R.string.diagnostic_health
                    DiagnosticStage.READY -> R.string.diagnostic_ready
                    DiagnosticStage.AUTHENTICATION -> R.string.diagnostic_authentication
                }
                append(if (step.passed) "✓ " else "✕ ")
                append(getString(stage))
                append(" · ")
                append(step.durationMillis)
                append(" ms")
                if (step.detail.isNotBlank()) {
                    append(" · ")
                    append(ConnectionDiagnosticReport.sanitize(step.detail))
                }
                appendLine()
            }
        }.trim()

    private fun loadTransportInputs() {
        val settings = GatewayTransportConfig.load(this)
        transportEndpointInput.setText(settings.endpoint)
        transportDeviceIdInput.setText(settings.deviceId)
        transportCertificatePinInput.setText(settings.certificatePinSha256Base64)
        transportEnabledSwitch.isChecked = settings.enabled
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
            toast(R.string.already_default_sms)
            return
        }
        controller.createRequestIntent()?.let(roleLauncher::launch)
            ?: toast(R.string.sms_role_unavailable)
    }

    private fun requestCallScreeningRole() {
        val controller = CallScreeningRoleController(this)
        if (controller.isRoleHeld()) {
            toast(R.string.already_call_screening)
            return
        }
        controller.createRequestIntent()?.let(callScreeningRoleLauncher::launch)
            ?: toast(R.string.call_screening_unavailable)
    }

    private fun openBatterySettings() {
        startActivity(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData("package:$packageName".toUri())
        )
    }

    private fun isIgnoringBatteryOptimizations(): Boolean {
        val pm = getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
        return pm.isIgnoringBatteryOptimizations(packageName)
    }

    private fun showLanguageDialog() {
        val values = arrayOf("", "en", "zh-CN")
        val labels = arrayOf(
            getString(R.string.language_system),
            getString(R.string.language_english),
            getString(R.string.language_chinese)
        )
        val current = AppCompatDelegate.getApplicationLocales().toLanguageTags()
        val checked = values.indexOf(current).takeIf { it >= 0 } ?: 0
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.language)
            .setSingleChoiceItems(labels, checked) { dialog, which ->
                val locales = if (values[which].isBlank()) {
                    LocaleListCompat.getEmptyLocaleList()
                } else {
                    LocaleListCompat.forLanguageTags(values[which])
                }
                dialog.dismiss()
                AppCompatDelegate.setApplicationLocales(locales)
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun currentLanguageLabel(): String = when {
        AppCompatDelegate.getApplicationLocales().toLanguageTags().startsWith("zh") ->
            getString(R.string.language_chinese)
        AppCompatDelegate.getApplicationLocales().toLanguageTags().startsWith("en") ->
            getString(R.string.language_english)
        else -> getString(R.string.language_system)
    }

    private fun confirmClearEvents() {
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.clear_events_title)
            .setMessage(R.string.clear_events_message)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.clear) { _, _ ->
                eventStore.clearEvents {
                    runOnUiThread {
                        toast(R.string.events_cleared)
                        refreshStoredEvents()
                    }
                }
            }
            .show()
    }

    private fun copyCode(code: String) {
        clipboard().setPrimaryClip(ClipData.newPlainText("OTP", code))
        toast(R.string.code_copied)
    }

    private fun copyLogs() {
        clipboard().setPrimaryClip(
            ClipData.newPlainText("CA Connection logs", buildSanitizedLogs())
        )
        toast(R.string.logs_copied)
    }

    private fun shareLogs() {
        startActivity(
            Intent.createChooser(
                Intent(Intent.ACTION_SEND)
                    .setType("text/plain")
                    .putExtra(Intent.EXTRA_SUBJECT, getString(R.string.sanitized_log_header))
                    .putExtra(Intent.EXTRA_TEXT, buildSanitizedLogs()),
                getString(R.string.share_logs_title)
            )
        )
    }

    private fun clipboard(): ClipboardManager =
        getSystemService(ClipboardManager::class.java)

    private fun visibleSubscriptions(): List<SubscriptionSnapshot> =
        activeSubscriptions.ifEmpty {
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

    private fun extractOtp(body: String): String? = UiPrivacy.extractOtp(body)

    private fun maskAddress(value: String): String =
        UiPrivacy.maskAddress(value, getString(R.string.unknown_sender))

    private fun categoryLetter(category: LogCategory): String = when (category) {
        LogCategory.SMS -> "M"
        LogCategory.CALL -> "C"
        LogCategory.NOTIFICATION -> "N"
        LogCategory.TRANSPORT -> "T"
    }

    private fun formatTime(time: Long): String =
        SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date(time))

    private fun formatCount(value: Int): String =
        NumberFormat.getIntegerInstance(Locale.getDefault()).format(value)

    private fun relativeTime(time: Long): String {
        val delta = (System.currentTimeMillis() - time).coerceAtLeast(0)
        return when {
            delta < 60_000 -> DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(time))
            delta < 3_600_000 -> getString(R.string.minutes_short, delta / 60_000)
            delta < 86_400_000 -> getString(R.string.hours_short, delta / 3_600_000)
            else -> DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(time))
        }
    }

    private fun isGranted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun toast(resource: Int) = toast(getString(resource))

    private fun toast(message: String) =
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()

    // Native Material view helpers. The UI stays XML/View based rather than
    // introducing a second rendering stack into this small gateway app.
    private fun card(
        background: Int = R.color.card_background,
        radius: Int = 20
    ) = MaterialCardView(this).apply {
        this.radius = dp(radius).toFloat()
        cardElevation = 0f
        setCardBackgroundColor(color(background))
        strokeColor = color(R.color.card_stroke)
        strokeWidth = dp(1)
        layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )
    }

    private fun vertical(
        padding: Int = 0,
        paddingVertical: Int = padding,
        paddingHorizontal: Int = padding
    ) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(
            dp(paddingHorizontal),
            dp(paddingVertical),
            dp(paddingHorizontal),
            dp(paddingVertical)
        )
    }

    private fun horizontal(
        gravity: Int = Gravity.NO_GRAVITY,
        padding: Int = 0,
        paddingVertical: Int = padding,
        paddingHorizontal: Int = padding
    ) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        this.gravity = gravity
        setPadding(
            dp(paddingHorizontal),
            dp(paddingVertical),
            dp(paddingHorizontal),
            dp(paddingVertical)
        )
    }

    private fun primaryText(value: String, size: Int, bold: Boolean = false) =
        TextView(this).apply {
            text = value
            textSize = size.toFloat()
            setTextColor(colorFromAttr(com.google.android.material.R.attr.colorOnSurface))
            if (bold) setTypeface(typeface, Typeface.BOLD)
        }

    private fun secondaryText(value: String, size: Int) =
        TextView(this).apply {
            text = value
            textSize = size.toFloat()
            setTextColor(color(R.color.text_secondary))
        }

    private fun sectionTitle(value: String, first: Boolean = false) =
        primaryText(value, 20, true).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = dp(if (first) 2 else 22)
                bottomMargin = dp(10)
            }
        }

    private fun sectionHeader(title: String, action: String, onClick: () -> Unit): View {
        val row = horizontal(gravity = Gravity.CENTER_VERTICAL)
        row.layoutParams = topMarginParams(16).apply { bottomMargin = dp(2) }
        row.addView(primaryText(title, 20, true), weightedParams())
        row.addView(textButton(action).apply { setOnClickListener { onClick() } })
        return row
    }

    private fun statCard(label: String): Pair<MaterialCardView, TextView> {
        val card = card(radius = 18)
        val body = vertical(paddingVertical = 13, paddingHorizontal = 6).apply {
            gravity = Gravity.CENTER
        }
        val value = primaryText("0", 22, true).apply { gravity = Gravity.CENTER }
        body.addView(value)
        body.addView(secondaryText(label, 12).apply { gravity = Gravity.CENTER }, topMarginParams(2))
        card.addView(body)
        return card to value
    }

    private fun metric(label: String): Pair<View, TextView> {
        val body = vertical(paddingVertical = 2, paddingHorizontal = 4).apply {
            gravity = Gravity.CENTER
        }
        val value = primaryText("0", 24, true).apply { gravity = Gravity.CENTER }
        body.addView(value)
        body.addView(secondaryText(label, 12).apply { gravity = Gravity.CENTER }, topMarginParams(2))
        return body to value
    }

    private fun addKeyValue(parent: LinearLayout, key: String, value: String): TextView {
        val row = horizontal(gravity = Gravity.CENTER_VERTICAL)
        row.minimumHeight = dp(34)
        row.addView(secondaryText(key, 13), linearParams(104, ViewGroup.LayoutParams.WRAP_CONTENT))
        val valueView = primaryText(value, 14).apply {
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        }
        row.addView(valueView, weightedParams())
        parent.addView(row)
        return valueView
    }

    private fun actionCard(
        title: String,
        detail: String,
        badge: String,
        onClick: () -> Unit
    ): MaterialCardView {
        val card = card(radius = 18)
        val row = horizontal(gravity = Gravity.CENTER_VERTICAL, padding = 16)
        val text = vertical()
        text.addView(primaryText(title, 16, true))
        text.addView(secondaryText(detail, 13), topMarginParams(3))
        row.addView(text, weightedParams())
        row.addView(statusPill(badge, Tone.BLUE))
        card.addView(row)
        card.isClickable = true
        card.isFocusable = true
        card.setOnClickListener { onClick() }
        return card
    }

    private fun primaryButton(text: String, icon: Int? = null) =
        MaterialButton(this).apply {
            this.text = text
            isAllCaps = false
            minHeight = dp(50)
            cornerRadius = dp(16)
            setTextColor(color(android.R.color.white))
            backgroundTintList =
                ColorStateList.valueOf(color(R.color.button_primary_background))
            elevation = dp(1).toFloat()
            icon?.let {
                setIconResource(it)
                iconGravity = MaterialButton.ICON_GRAVITY_TEXT_START
                iconTint = ColorStateList.valueOf(color(android.R.color.white))
            }
        }

    private fun outlinedButton(text: String, icon: Int? = null) =
        MaterialButton(
            this,
            null,
            com.google.android.material.R.attr.materialButtonOutlinedStyle
        ).apply {
            this.text = text
            isAllCaps = false
            minHeight = dp(50)
            cornerRadius = dp(16)
            setTextColor(color(R.color.brand_blue))
            backgroundTintList = ColorStateList.valueOf(color(R.color.card_background))
            strokeColor = ColorStateList.valueOf(color(R.color.brand_blue))
            strokeWidth = dp(1)
            icon?.let {
                setIconResource(it)
                iconTint = ColorStateList.valueOf(color(R.color.brand_blue))
            }
        }

    private fun textButton(text: String) =
        MaterialButton(this).apply {
            this.text = text
            isAllCaps = false
            minHeight = dp(44)
            cornerRadius = dp(14)
            setTextColor(color(R.color.brand_blue))
            backgroundTintList = ColorStateList.valueOf(color(R.color.brand_blue_soft))
            insetTop = 0
            insetBottom = 0
        }

    private fun textField(
        hint: String,
        inputType: Int,
        helper: String? = null,
        minLines: Int = 1,
        passwordToggle: Boolean = false
    ): TextField {
        val layout = TextInputLayout(
            this,
            null,
            com.google.android.material.R.attr.textInputOutlinedStyle
        ).apply {
            this.hint = hint
            helperText = helper
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
            setBoxStrokeColorStateList(
                ColorStateList(
                    arrayOf(
                        intArrayOf(android.R.attr.state_focused),
                        intArrayOf()
                    ),
                    intArrayOf(
                        color(R.color.brand_blue),
                        color(R.color.control_stroke)
                    )
                )
            )
            if (passwordToggle) endIconMode = TextInputLayout.END_ICON_PASSWORD_TOGGLE
        }
        val edit = TextInputEditText(layout.context).apply {
            this.inputType = inputType
            this.minLines = minLines
            if (minLines > 1) gravity = Gravity.TOP or Gravity.START
            isVerticalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        }
        layout.addView(
            edit,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        )
        return TextField(layout, edit)
    }

    private fun filterChip(id: Int, text: Int, checked: Boolean = false) =
        Chip(this).apply {
            this.id = id
            setText(text)
            isCheckable = true
            isChecked = checked
            chipBackgroundColor = ColorStateList(
                arrayOf(
                    intArrayOf(android.R.attr.state_checked),
                    intArrayOf()
                ),
                intArrayOf(
                    color(R.color.brand_blue_soft),
                    color(R.color.card_background)
                )
            )
            chipStrokeColor = ColorStateList(
                arrayOf(
                    intArrayOf(android.R.attr.state_checked),
                    intArrayOf()
                ),
                intArrayOf(
                    color(R.color.brand_blue),
                    color(R.color.control_stroke)
                )
            )
            setTextColor(
                ColorStateList(
                    arrayOf(
                        intArrayOf(android.R.attr.state_checked),
                        intArrayOf()
                    ),
                    intArrayOf(
                        color(R.color.brand_blue),
                        color(R.color.control_text)
                    )
                )
            )
            chipStrokeWidth = dp(1).toFloat()
            shapeAppearanceModel = shapeAppearanceModel
                .toBuilder()
                .setAllCornerSizes(dp(18).toFloat())
                .build()
            minHeight = dp(42)
            setEnsureMinTouchTargetSize(false)
        }

    private fun statusPill(text: String, tone: Tone) = TextView(this).apply {
        gravity = Gravity.CENTER
        this.text = text
        textSize = 12f
        setTypeface(typeface, Typeface.BOLD)
        setPadding(dp(10), dp(6), dp(10), dp(6))
        updatePill(this, text, tone)
    }

    private fun updatePill(view: TextView, text: String, tone: Tone) {
        view.text = text
        view.setTextColor(color(tone.foreground))
        view.background = roundedDrawable(tone.background, 100)
    }

    private fun badgeLetter(text: String, tone: Tone) = TextView(this).apply {
        this.text = text
        gravity = Gravity.CENTER
        textSize = 15f
        setTypeface(typeface, Typeface.BOLD)
        setTextColor(color(tone.foreground))
        background = roundedDrawable(tone.background, 16)
    }

    private fun divider(vertical: Boolean = false) = View(this).apply {
        setBackgroundColor(color(R.color.divider))
        layoutParams = if (vertical) {
            LinearLayout.LayoutParams(dp(1), ViewGroup.LayoutParams.MATCH_PARENT).apply {
                topMargin = dp(4)
                bottomMargin = dp(4)
            }
        } else {
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)).apply {
                marginStart = dp(54)
            }
        }
    }

    private fun emptyState(text: String, compact: Boolean = false) =
        secondaryText(text, 14).apply {
            gravity = Gravity.CENTER
            setPadding(dp(20), dp(if (compact) 18 else 30), dp(20), dp(if (compact) 18 else 30))
        }

    private fun roundedDrawable(fill: Int, radius: Int, stroke: Int? = null) =
        GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(radius).toFloat()
            setColor(color(fill))
            stroke?.let { setStroke(dp(1), color(it)) }
        }

    private fun topMarginParams(top: Int) =
        LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(top) }

    private fun weightedParams(
        marginStart: Int = 0,
        marginEnd: Int = 0
    ) = LinearLayout.LayoutParams(
        0,
        ViewGroup.LayoutParams.WRAP_CONTENT,
        1f
    ).apply {
        this.marginStart = dp(marginStart)
        this.marginEnd = dp(marginEnd)
    }

    private fun linearParams(width: Int, height: Int) =
        LinearLayout.LayoutParams(
            if (width >= 0) dp(width) else width,
            if (height >= 0) dp(height) else height
        )

    private fun color(resource: Int): Int = ContextCompat.getColor(this, resource)

    private fun colorFromAttr(attribute: Int): Int {
        val values = intArrayOf(attribute)
        val typed = obtainStyledAttributes(values)
        return typed.getColor(0, color(R.color.text_secondary)).also { typed.recycle() }
    }

    private fun dp(value: Int): Int =
        (value * resources.displayMetrics.density).toInt()

    private data class TextField(
        val layout: TextInputLayout,
        val editText: TextInputEditText
    )

    private data class ReadinessUi(
        val title: String,
        val detail: String,
        val passed: Boolean,
        val optional: Boolean = false
    )

    private data class UiLogEntry(
        val time: Long,
        val category: LogCategory,
        val tone: Tone,
        val title: String,
        val detail: String,
        val status: String
    )

    private sealed class MessageItem(val time: Long) {
        class Incoming(val event: IncomingSmsEventEntity) : MessageItem(event.receivedAt)
        class Outgoing(val event: OutgoingSmsEventEntity) : MessageItem(event.updatedAt)
    }

    private enum class MessageFilter { ALL, INCOMING, OUTGOING, OTP }
    private enum class LogFilter { ALL, ERRORS, SMS, CALLS, NOTIFICATIONS, TRANSPORT }
    private enum class LogCategory { SMS, CALL, NOTIFICATION, TRANSPORT }

    private enum class Tone(val foreground: Int, val background: Int) {
        SUCCESS(R.color.status_success, R.color.status_success_background),
        WARNING(R.color.status_warning, R.color.status_warning_background),
        ERROR(R.color.status_error, R.color.status_error_background),
        BLUE(R.color.brand_blue, R.color.brand_blue_soft),
        PURPLE(R.color.brand_purple, R.color.brand_purple_soft),
        NEUTRAL(R.color.text_secondary, R.color.status_neutral_background)
    }

    companion object {
        const val EXTRA_OPEN_PAGE = "open_page"
        const val PAGE_DASHBOARD = "dashboard"
        const val PAGE_INCOMING = "incoming"
        const val PAGE_DIAGNOSTICS = "diagnostics"
        const val PAGE_SIGNALS = "signals"
        const val PAGE_TRANSPORT = "transport"
        const val PAGE_HOME = "home"
        const val PAGE_MESSAGES = "messages"
        const val PAGE_ACTIVITY = "activity"
        const val PAGE_SETTINGS = "settings"
        private const val REQUEST_PERMISSIONS = 1001
        private const val STATE_PAGE = "selected_page"
        private const val MAX_VISIBLE_MESSAGES = 100
        private const val MAX_VISIBLE_LOGS = 100
    }
}
