<template>
  <div class="dashboard-layout">
    <!-- Navigation -->
    <nav class="navbar" :aria-label="t('nav.main')">
      <div class="container">
        <div class="navbar-content">
          <div class="navbar-brand">
            <h1 class="navbar-title">{{ t('app.name') }}</h1>
          </div>

          <div class="navbar-menu">
            <div class="navbar-tabs" role="tablist">
              <button
                class="tab"
                :class="{ active: activeTab === 'dashboard' }"
                role="tab"
                :aria-selected="activeTab === 'dashboard'"
                aria-controls="dashboard-panel"
                @click="activeTab = 'dashboard'"
              >
                {{ t('nav.dashboard') }}
              </button>
              <button
                class="tab"
                :class="{ active: activeTab === 'messages' }"
                role="tab"
                :aria-selected="activeTab === 'messages'"
                aria-controls="messages-panel"
                @click="activeTab = 'messages'"
              >
                {{ t('nav.messages') }}
              </button>
            </div>

            <div class="navbar-actions">
              <LanguageSwitcher />
              <button class="btn btn-ghost btn-sm" @click="handleLogout">
                {{ t('nav.logout') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </nav>

    <!-- Main Content -->
    <main class="main-content">
      <div class="container">
        <!-- Read-only notice -->
        <div class="notice-bar" role="note">
          <span class="notice-icon" aria-hidden="true">i</span>
          <span>{{ t('dashboard.readOnlyNotice') }}</span>
        </div>

        <!-- Dashboard Tab -->
        <div
          v-if="activeTab === 'dashboard'"
          id="dashboard-panel"
          class="dashboard-content"
          role="tabpanel"
        >
          <div class="dashboard-header">
            <h2>{{ t('dashboard.title') }}</h2>
            <div class="dashboard-header-actions">
              <span class="last-refresh">
                {{ t('dashboard.lastRefresh') }}:
                <strong>
                  {{ lastRefreshTime ? formatTime(lastRefreshTime) : t('dashboard.never') }}
                </strong>
              </span>
              <button
                class="btn btn-secondary btn-sm"
                :disabled="refreshing"
                @click="refreshAll"
              >
                <span v-if="refreshing" class="spinner" aria-hidden="true" />
                {{ refreshing ? t('dashboard.refreshing') : t('dashboard.refresh') }}
              </button>
            </div>
          </div>

          <div class="dashboard-grid">
            <!-- Gateway Status Card -->
            <div class="card status-card">
              <h3 class="card-title">{{ t('dashboard.gatewayStatus') }}</h3>
              <div class="status-items">
                <div class="status-item">
                  <span class="status-label">{{ t('dashboard.health') }}</span>
                  <span class="status-indicator">
                    <span
                      class="status-symbol"
                      :class="status?.health?.ok ? 'status-symbol-success' : 'status-symbol-danger'"
                      aria-hidden="true"
                    >{{ status?.health?.ok ? '✓' : '×' }}</span>
                    <span :class="status?.health?.ok ? 'text-success' : 'text-danger'">
                      {{ status?.health?.ok ? t('dashboard.online') : t('dashboard.offline') }}
                    </span>
                  </span>
                </div>

                <div class="status-item">
                  <span class="status-label">{{ t('dashboard.ready') }}</span>
                  <span class="status-indicator">
                    <span
                      class="status-symbol"
                      :class="status?.ready?.ok ? 'status-symbol-success' : 'status-symbol-danger'"
                      aria-hidden="true"
                    >{{ status?.ready?.ok ? '✓' : '×' }}</span>
                    <span :class="status?.ready?.ok ? 'text-success' : 'text-danger'">
                      {{ status?.ready?.status || t('dashboard.unknown') }}
                    </span>
                  </span>
                </div>

                <div class="status-item">
                  <span class="status-label">{{ t('dashboard.version') }}</span>
                  <span class="status-value">
                    {{ status?.version?.version || t('dashboard.unknown') }}
                  </span>
                </div>
              </div>
            </div>

            <div v-if="gatewayError" class="dashboard-error" role="alert">
              <strong>{{ t('dashboard.diagnosticsFailed') }}</strong>
              <span>{{ gatewayError }}</span>
            </div>

            <!-- Message Statistics Card -->
            <div class="card stats-card">
              <h3 class="card-title">{{ t('messages.title') }}</h3>
              <div class="stats-items">
                <div class="stat-item">
                  <span class="stat-value">{{ simCounts.sim1 }}</span>
                  <span class="stat-label">{{ t('dashboard.sim1Count') }}</span>
                </div>
                <div class="stat-item">
                  <span class="stat-value">{{ simCounts.sim2 }}</span>
                  <span class="stat-label">{{ t('dashboard.sim2Count') }}</span>
                </div>
              </div>
              <div class="stat-footer">
                <span class="stat-label">{{ t('dashboard.latestMessage') }}:</span>
                <span class="stat-value">
                  {{ latestMessageTime ? formatTime(latestMessageTime) : t('dashboard.never') }}
                </span>
              </div>
            </div>

            <div class="card pairing-card">
              <div class="pairing-heading">
                <div>
                  <h3 class="card-title">{{ t('pairing.title') }}</h3>
                  <p class="text-muted">{{ t('pairing.description') }}</p>
                </div>
                <span class="pairing-security">{{ t('pairing.oneTime') }}</span>
              </div>
              <label class="pairing-label" for="pairing-device">
                {{ t('pairing.device') }}
              </label>
              <select
                id="pairing-device"
                v-model="pairingDevice"
                class="pairing-select"
                :disabled="pairingLoading || devices.length === 0"
              >
                <option v-if="devices.length === 0" value="">
                  {{ t('pairing.noDevices') }}
                </option>
                <option v-for="device in devices" :key="device" :value="device">
                  {{ device }}
                </option>
              </select>
              <button
                class="btn btn-primary pairing-create"
                :disabled="pairingLoading || !pairingDevice"
                @click="generatePairing"
              >
                <span v-if="pairingLoading" class="spinner" aria-hidden="true" />
                {{ pairingLoading ? t('pairing.generating') : t('pairing.generate') }}
              </button>
              <p class="pairing-replacement-note">
                {{ t('pairing.replacementNotice') }}
              </p>
              <p v-if="pairingError" class="text-danger pairing-error">
                {{ pairingError }}
              </p>
              <div v-if="pairingQr" class="pairing-result" aria-live="polite">
                <img
                  :src="pairingQr"
                  :alt="t('pairing.qrAlt')"
                  class="pairing-qr"
                >
                <div class="pairing-instructions">
                  <strong>{{ t('pairing.scanNow') }}</strong>
                  <span>
                    {{ pairingSeconds > 0
                      ? t('pairing.expiresIn', { seconds: pairingSeconds })
                      : t('pairing.expired') }}
                  </span>
                  <small>{{ t('pairing.secretNotice') }}</small>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Messages Tab -->
        <div
          v-if="activeTab === 'messages'"
          id="messages-panel"
          class="messages-content"
          role="tabpanel"
        >
          <div class="messages-header">
            <h2>{{ t('messages.title') }}</h2>
            <div class="messages-controls">
              <div class="filter-buttons" role="group" :aria-label="t('messages.filter.all')">
                <button
                  class="btn btn-sm"
                  :class="currentFilter === null ? 'btn-primary' : 'btn-secondary'"
                  @click="currentFilter = null"
                >
                  {{ t('messages.filter.all') }}
                </button>
                <button
                  class="btn btn-sm"
                  :class="currentFilter === 0 ? 'btn-primary' : 'btn-secondary'"
                  @click="currentFilter = 0"
                >
                  {{ t('messages.filter.sim1') }}
                </button>
                <button
                  class="btn btn-sm"
                  :class="currentFilter === 1 ? 'btn-primary' : 'btn-secondary'"
                  @click="currentFilter = 1"
                >
                  {{ t('messages.filter.sim2') }}
                </button>
              </div>

              <button
                class="btn btn-secondary btn-sm"
                :disabled="messagesLoading"
                @click="refreshMessages"
              >
                <span v-if="messagesLoading" class="spinner" aria-hidden="true" />
                {{ messagesLoading ? t('messages.refreshing') : t('messages.refresh') }}
              </button>
            </div>
          </div>

          <!-- Loading State -->
          <div v-if="messagesLoading && messages.length === 0" class="loading-state">
            <div class="spinner spinner-lg" aria-hidden="true" />
            <p>{{ t('common.loading') }}</p>
          </div>

          <!-- Error State -->
          <div v-else-if="gatewayError" class="error-state">
            <div class="error-state-icon" aria-hidden="true">!</div>
            <p>{{ t('messages.error') }}</p>
            <p class="text-muted">{{ gatewayError }}</p>
            <button class="btn btn-primary" @click="refreshMessages">
              {{ t('messages.retry') }}
            </button>
          </div>

          <!-- Empty State -->
          <div v-else-if="filteredMessages.length === 0" class="empty-state">
            <div class="empty-state-icon" aria-hidden="true">—</div>
            <p>{{ t('messages.empty') }}</p>
          </div>

          <!-- Messages List -->
          <div v-else class="messages-list">
            <MessageCard
              v-for="message in filteredMessages"
              :key="message.id"
              :message="message"
            />
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import QRCode from 'qrcode'

const { t, locale } = useI18n()
const { logout } = useAuth()
const {
  status,
  messages,
  isLoading: messagesLoading,
  error: gatewayError,
  simCounts,
  latestMessageTime,
  fetchStatus,
  fetchMessages,
  fetchDevices,
  createPairing,
} = useGateway()

// State
const activeTab = ref<'dashboard' | 'messages'>('dashboard')
const currentFilter = ref<number | null>(null)
const refreshing = ref(false)
const lastRefreshTime = ref<number | null>(null)
const devices = ref<string[]>([])
const pairingDevice = ref('')
const pairingQr = ref('')
const pairingExpiresAt = ref(0)
const pairingNow = ref(Date.now())
const pairingLoading = ref(false)
const pairingError = ref('')
let pairingTimer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  await Promise.all([refreshAll(), loadDevices()])
  pairingTimer = setInterval(() => {
    pairingNow.value = Date.now()
    if (pairingExpiresAt.value && pairingSeconds.value <= 0) {
      pairingQr.value = ''
    }
  }, 1000)
})

onBeforeUnmount(() => {
  if (pairingTimer) clearInterval(pairingTimer)
})

const pairingSeconds = computed(() =>
  Math.max(0, Math.ceil((pairingExpiresAt.value - pairingNow.value) / 1000))
)

// Filtered messages
const filteredMessages = computed(() => {
  if (currentFilter.value === null) {
    return messages.value
  }
  return messages.value.filter(m => m.slotIndex === currentFilter.value)
})

// Format timestamp
function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(timestamp))
}

// Refresh all data
async function refreshAll() {
  refreshing.value = true
  try {
    await Promise.all([
      fetchStatus(),
      fetchMessages({ limit: 50 }),
    ])
    lastRefreshTime.value = Date.now()
  } finally {
    refreshing.value = false
  }
}

// Refresh messages only
async function refreshMessages() {
  await fetchMessages({
    limit: 50,
    slotIndex: currentFilter.value,
  })
  lastRefreshTime.value = Date.now()
}

async function loadDevices() {
  try {
    devices.value = await fetchDevices()
    pairingError.value = ''
    if (!devices.value.includes(pairingDevice.value)) {
      pairingDevice.value = devices.value[0] || ''
    }
  } catch {
    pairingError.value = t('pairing.loadError')
  }
}

async function generatePairing() {
  if (!pairingDevice.value) return
  pairingLoading.value = true
  pairingError.value = ''
  try {
    const result = await createPairing({
      deviceId: pairingDevice.value,
      expiresInSeconds: 300,
    })
    pairingQr.value = await QRCode.toDataURL(result.pairing.payload, {
      width: 320,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b1220', light: '#ffffff' },
    })
    pairingExpiresAt.value = result.pairing.expiresAt
    pairingNow.value = Date.now()
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode
    pairingError.value = statusCode === 429
      ? t('pairing.rateLimited')
      : t('pairing.generateError')
  } finally {
    pairingLoading.value = false
  }
}

// Handle logout
async function handleLogout() {
  await logout()
}
</script>

<style scoped>
.dashboard-layout {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

/* Navbar */
.navbar {
  background-color: var(--color-bg-card);
  border-bottom: 1px solid var(--color-border);
  padding: 0.75rem 0;
  position: sticky;
  top: 0;
  z-index: 50;
}

.navbar-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.navbar-title {
  font-size: 1.125rem;
  font-weight: 750;
  letter-spacing: -0.01em;
}

.navbar-menu {
  display: flex;
  align-items: center;
  gap: var(--space-lg);
}

.navbar-tabs {
  display: flex;
  gap: var(--space-xs);
}

.tab {
  padding: var(--space-sm) var(--space-md);
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--color-text-secondary);
  background: none;
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--transition-fast);
  min-height: 2.5rem;
}

.tab:hover,
.tab:focus-visible {
  color: var(--color-text);
  background-color: var(--color-bg-subtle);
}

.tab.active {
  color: var(--color-primary-text);
  background-color: var(--color-primary-light);
}

.tab:focus-visible {
  outline: 3px solid var(--color-border-focus);
  outline-offset: 2px;
}

.navbar-actions {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.pairing-card {
  grid-column: 1 / -1;
}

.pairing-heading,
.pairing-result {
  display: flex;
  align-items: center;
  gap: var(--space-lg);
}

.pairing-heading {
  justify-content: space-between;
  margin-bottom: var(--space-md);
}

.pairing-security {
  color: var(--color-success-text);
  background: var(--color-success-light);
  border-radius: 999px;
  padding: 0.35rem 0.65rem;
  font-size: 0.75rem;
  font-weight: 600;
  white-space: nowrap;
}

.pairing-label {
  display: block;
  font-size: 0.8125rem;
  font-weight: 600;
  margin-bottom: var(--space-xs);
}

.pairing-select {
  width: min(100%, 28rem);
  min-height: 2.75rem;
  color: var(--color-text);
  background: var(--color-bg-input);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 0 var(--space-sm);
}

.pairing-select:focus-visible {
  outline: 3px solid var(--color-border-focus);
  outline-offset: 2px;
}

.pairing-create {
  margin-left: var(--space-sm);
}

.pairing-error {
  margin-top: var(--space-sm);
}

.pairing-replacement-note {
  max-width: 38rem;
  margin: var(--space-sm) 0 0;
  color: var(--color-text-muted);
  font-size: 0.75rem;
}

.pairing-result {
  margin-top: var(--space-lg);
  padding-top: var(--space-lg);
  border-top: 1px solid var(--color-border);
}

.pairing-qr {
  width: min(16rem, 60vw);
  height: auto;
  border-radius: var(--radius-md);
  background: white;
  border: 0.5rem solid white;
  box-shadow: var(--shadow-md);
}

.pairing-instructions {
  display: grid;
  gap: var(--space-sm);
}

@media (max-width: 640px) {
  .pairing-heading,
  .pairing-result {
    align-items: stretch;
    flex-direction: column;
  }

  .pairing-create {
    width: 100%;
    margin: var(--space-sm) 0 0;
  }
}

/* Main Content */
.main-content {
  flex: 1;
  padding: var(--space-xl) 0;
}

/* Notice Bar */
.notice-bar {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  background-color: var(--color-info-light);
  color: var(--color-info-text);
  border: 1px solid color-mix(in srgb, var(--color-info) 45%, transparent);
  border-radius: var(--radius-md);
  font-size: 0.875rem;
  margin-bottom: var(--space-xl);
}

.notice-icon {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 1.25rem;
  height: 1.25rem;
  border: 1px solid currentColor;
  border-radius: 50%;
  font-size: 0.75rem;
  font-weight: 800;
}

/* Dashboard */
.dashboard-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-lg);
}

.dashboard-header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-md);
}

.last-refresh {
  color: var(--color-text-secondary);
  font-size: 0.75rem;
}

.last-refresh strong {
  color: var(--color-text);
  font-weight: 650;
}

.dashboard-grid {
  display: grid;
  gap: var(--space-lg);
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
}

.status-items {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

.status-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.status-label {
  font-size: 0.875rem;
  color: var(--color-text-secondary);
}

.status-value {
  font-weight: 500;
}

.status-symbol {
  display: grid;
  place-items: center;
  width: 1.25rem;
  height: 1.25rem;
  border-radius: 50%;
  color: white;
  font-size: 0.8rem;
  font-weight: 800;
}

.status-symbol-success {
  background: #047857;
}

.status-symbol-danger {
  background: #b91c1c;
}

.dashboard-error {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-sm);
  padding: var(--space-md);
  color: var(--color-danger-text);
  background: var(--color-danger-light);
  border: 1px solid color-mix(in srgb, var(--color-danger) 45%, transparent);
  border-radius: var(--radius-md);
}

.stats-items {
  display: flex;
  gap: var(--space-xl);
  margin-bottom: var(--space-md);
}

.stat-item {
  text-align: center;
}

.stat-value {
  display: block;
  font-size: 2rem;
  font-weight: 700;
  color: var(--color-primary-text);
}

.stat-label {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
}

.stat-footer {
  padding-top: var(--space-md);
  border-top: 1px solid var(--color-border);
  font-size: 0.875rem;
}

.stat-footer .stat-value {
  display: inline;
  color: var(--color-text);
  font-size: 0.875rem;
  font-weight: 650;
}

/* Messages */
.messages-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-lg);
  flex-wrap: wrap;
  gap: var(--space-md);
}

.messages-controls {
  display: flex;
  align-items: center;
  gap: var(--space-md);
}

.filter-buttons {
  display: flex;
  gap: var(--space-xs);
}

.messages-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

/* Loading State */
.loading-state {
  text-align: center;
  padding: var(--space-2xl);
}

.spinner-lg {
  width: 2rem;
  height: 2rem;
  border-width: 3px;
  margin: 0 auto var(--space-md);
}

/* Responsive */
@media (max-width: 768px) {
  .navbar-content {
    align-items: stretch;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .navbar-menu {
    width: 100%;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .navbar-tabs {
    width: 100%;
  }

  .tab {
    flex: 1;
    text-align: center;
  }

  .navbar-actions {
    width: 100%;
    justify-content: space-between;
  }

  .navbar-brand {
    padding: 0 var(--space-xs);
  }

  .dashboard-header {
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-md);
  }

  .dashboard-header-actions {
    width: 100%;
    align-items: stretch;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .dashboard-header-actions .btn {
    width: 100%;
  }

  .messages-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .messages-controls {
    width: 100%;
    flex-direction: column;
  }

  .messages-controls > .btn {
    width: 100%;
  }

  .filter-buttons {
    width: 100%;
  }

  .filter-buttons .btn {
    flex: 1;
  }

  .stats-items {
    justify-content: center;
  }
}
</style>
