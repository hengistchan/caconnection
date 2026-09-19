<template>
  <div class="dashboard-layout">
    <nav class="navbar" :aria-label="t('nav.main')">
      <div class="container navbar-content">
        <h1 class="navbar-title">{{ t('app.name') }}</h1>
        <div class="navbar-menu">
          <div class="navbar-tabs" role="tablist" @keydown="handleTabKeydown">
            <button
              v-for="tab in tabs"
              :id="`${tab.id}-tab`"
              :key="tab.id"
              :ref="el => setTabRef(tab.id, el)"
              class="tab"
              :class="{ active: activeTab === tab.id }"
              role="tab"
              :tabindex="activeTab === tab.id ? 0 : -1"
              :aria-selected="activeTab === tab.id"
              :aria-controls="`${tab.id}-panel`"
              @click="selectTab(tab.id)"
            >
              {{ t(tab.label) }}
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
    </nav>

    <main class="main-content">
      <div class="container">
        <div class="notice-bar" role="note">
          <span class="notice-icon" aria-hidden="true">i</span>
          <span>{{ t('dashboard.readOnlyNotice') }}</span>
        </div>

        <div class="card fleet-context">
          <label class="filter-field">
            <span>{{ t('fleet.context') }}</span>
            <select v-model="selectedDeviceId" class="filter-select">
              <option value="all">{{ t('fleet.allDevices') }}</option>
              <option
                v-for="device in deviceDetails"
                :key="device.deviceId"
                :value="device.deviceId"
              >
                {{ device.deviceId }} · {{ t(`fleet.health.${device.health}`) }}
              </option>
              <option
                v-for="group in deviceGroups"
                :key="`group-${group.groupId}`"
                :value="`group:${group.groupId}`"
              >
                {{ t('groups.prefix') }}: {{ group.name }}
              </option>
            </select>
          </label>
          <span class="section-subtitle">{{ t('fleet.contextHelp') }}</span>
        </div>

        <section
          v-if="activeTab === 'dashboard'"
          id="dashboard-panel"
          role="tabpanel"
          aria-labelledby="dashboard-tab"
        >
          <div class="section-header">
            <div>
              <h2>{{ t('dashboard.title') }}</h2>
              <p class="section-subtitle">{{ t('dashboard.subtitle') }}</p>
            </div>
            <button
              class="btn btn-secondary btn-sm"
              :disabled="dashboardRefreshing"
              @click="refreshDashboard()"
            >
              <span v-if="dashboardRefreshing" class="spinner" aria-hidden="true" />
              {{ dashboardRefreshing ? t('dashboard.refreshing') : t('dashboard.refresh') }}
            </button>
          </div>

          <div class="refresh-summary" aria-live="polite">
            <span>{{ t('dashboard.statusUpdated') }}: {{ formatOptionalTime(statusLastSuccessAt) }}</span>
            <span>{{ t('dashboard.messagesUpdated') }}: {{ formatOptionalTime(messageLastSuccessAt) }}</span>
            <span>{{ t('dashboard.notificationsUpdated') }}: {{ formatOptionalTime(notificationLastSuccessAt) }}</span>
          </div>

          <div class="dashboard-grid">
            <article class="card status-card">
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
                  <span>{{ status?.version?.version || t('dashboard.unknown') }}</span>
                </div>
              </div>
              <p v-if="statusError" class="inline-alert inline-alert-error" role="alert">
                {{ statusError }}
              </p>
            </article>

            <article class="card stats-card">
              <h3 class="card-title">{{ t('dashboard.messageStats') }}</h3>
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
                {{ t('dashboard.latestMessage') }}:
                <strong>{{ formatOptionalTime(latestMessageTime) }}</strong>
              </div>
            </article>

            <article class="card stats-card">
              <h3 class="card-title">{{ t('dashboard.notificationStats') }}</h3>
              <div class="stats-items">
                <div class="stat-item">
                  <span class="stat-value">{{ postedNotifications.length }}</span>
                  <span class="stat-label">{{ t('dashboard.loadedNotifications') }}</span>
                </div>
                <div class="stat-item">
                  <span class="stat-value">{{ notificationSources.length }}</span>
                  <span class="stat-label">{{ t('dashboard.notificationSources') }}</span>
                </div>
              </div>
              <div class="stat-footer">
                {{ t('dashboard.latestNotification') }}:
                <strong>{{ formatOptionalTime(latestNotificationTime) }}</strong>
              </div>
            </article>

            <article class="card device-summary-card">
              <div class="card-heading">
                <h3 class="card-title">{{ t('devices.title') }}</h3>
                <button class="btn btn-secondary btn-sm" @click="selectTab('devices')">
                  {{ t('devices.manage') }}
                </button>
              </div>
              <div class="stats-items">
                <div class="stat-item">
                  <span class="stat-value">{{ deviceDetails.length }}</span>
                  <span class="stat-label">{{ t('devices.configuredCount') }}</span>
                </div>
              </div>
              <div class="stat-footer">
                {{ t('devices.latestActivity') }}:
                <strong>{{ formatOptionalTime(latestDeviceActivity) }}</strong>
              </div>
              <p v-if="deviceError" class="inline-alert inline-alert-error" role="alert">
                {{ deviceError }}
              </p>
            </article>
          </div>
        </section>

        <section
          v-if="activeTab === 'messages'"
          id="messages-panel"
          role="tabpanel"
          aria-labelledby="messages-tab"
        >
          <div class="section-header messages-heading">
            <div>
              <h2>{{ t('messages.title') }}</h2>
              <p class="section-subtitle">
                {{ t('messages.loadedSummary', { count: filteredTimeline.length }) }}
              </p>
            </div>
            <div class="section-actions">
              <button class="btn btn-secondary btn-sm" @click="toggleRevealAll">
                {{ revealAll
                  ? t('messages.hideAll')
                  : t('messages.revealAll', { seconds: privacySeconds || 30 }) }}
              </button>
              <button
                class="btn btn-secondary btn-sm"
                :disabled="contentLoading"
                @click="refreshContent"
              >
                <span v-if="contentLoading" class="spinner" aria-hidden="true" />
                {{ contentLoading ? t('messages.refreshing') : t('messages.refresh') }}
              </button>
            </div>
          </div>

          <div class="filter-panel card">
            <div class="filter-row">
              <div class="segmented-control" role="group" :aria-label="t('messages.filter.contentType')">
                <button
                  v-for="option in contentFilterOptions"
                  :key="option.value"
                  type="button"
                  class="segment"
                  :class="{ active: contentFilter === option.value }"
                  @click="contentFilter = option.value"
                >
                  {{ t(option.label) }}
                  <span class="segment-count">{{ option.count }}</span>
                </button>
              </div>

              <label
                v-if="
                  contentFilter !== 'notifications'
                  && selectedDeviceId !== 'all'
                  && !selectedDeviceId.startsWith('group:')
                "
                class="filter-field"
              >
                <span>{{ t('messages.filter.sim') }}</span>
                <select v-model="currentFilter" class="filter-select">
                  <option :value="null">{{ t('messages.filter.allSims') }}</option>
                  <option :value="0">{{ t('messages.filter.sim1') }}</option>
                  <option :value="1">{{ t('messages.filter.sim2') }}</option>
                </select>
              </label>

              <label v-if="contentFilter !== 'sms'" class="filter-field">
                <span>{{ t('messages.filter.sourceApp') }}</span>
                <select v-model="sourcePackageFilter" class="filter-select">
                  <option value="">{{ t('messages.filter.allApps') }}</option>
                  <option
                    v-for="sourcePackage in notificationSources"
                    :key="sourcePackage"
                    :value="sourcePackage"
                  >
                    {{ sourcePackage }}
                  </option>
                </select>
              </label>
            </div>

            <div class="filter-row">
              <label class="filter-field search-field">
                <span>{{ t('messages.filter.search') }}</span>
                <input
                  v-model.trim="searchQuery"
                  class="form-input"
                  type="search"
                  :placeholder="t('messages.filter.searchPlaceholder')"
                >
              </label>
              <label class="filter-field">
                <span>{{ t('messages.filter.dateRange') }}</span>
                <select v-model="dateRange" class="filter-select">
                  <option value="all">{{ t('messages.filter.dateAll') }}</option>
                  <option value="today">{{ t('messages.filter.today') }}</option>
                  <option value="7d">{{ t('messages.filter.last7Days') }}</option>
                  <option value="30d">{{ t('messages.filter.last30Days') }}</option>
                </select>
              </label>
              <button
                v-if="hasActiveFilters"
                type="button"
                class="btn btn-ghost btn-sm reset-filter"
                @click="resetFilters"
              >
                {{ t('messages.filter.reset') }}
              </button>
            </div>
          </div>

          <div class="partial-alerts">
            <div v-if="messageError" class="inline-alert inline-alert-warning" role="alert">
              <span>{{ t('messages.smsLoadFailed') }}</span>
              <button class="btn btn-ghost btn-sm" @click="retryMessages">
                {{ t('common.retry') }}
              </button>
            </div>
            <div v-if="notificationError" class="inline-alert inline-alert-warning" role="alert">
              <span>{{ t('messages.notificationLoadFailed') }}</span>
              <button class="btn btn-ghost btn-sm" @click="retryNotifications">
                {{ t('common.retry') }}
              </button>
            </div>
          </div>

          <div
            v-if="contentLoading && messages.length === 0 && notifications.length === 0"
            class="loading-state"
          >
            <div class="spinner spinner-lg" aria-hidden="true" />
            <p>{{ t('common.loading') }}</p>
          </div>

          <div v-else-if="filteredTimeline.length === 0" class="empty-state card">
            <div class="empty-state-icon" aria-hidden="true">—</div>
            <p>{{ emptyStateText }}</p>
            <button v-if="hasActiveFilters" class="btn btn-secondary" @click="resetFilters">
              {{ t('messages.filter.reset') }}
            </button>
          </div>

          <div v-else class="messages-list">
            <template v-for="item in filteredTimeline" :key="item.key">
              <MessageCard
                v-if="item.kind === 'sms'"
                :message="item.message"
                :reveal-all="revealAll"
              />
              <NotificationCard
                v-else
                :notification="item.notification"
                :reveal-all="revealAll"
              />
            </template>
          </div>

          <div v-if="canLoadMore" class="load-more-row">
            <button
              class="btn btn-secondary"
              :disabled="contentLoading"
              @click="loadMore"
            >
              <span v-if="contentLoading" class="spinner" aria-hidden="true" />
              {{ t('messages.loadMore') }}
            </button>
          </div>
        </section>

        <section
          v-if="activeTab === 'outbound'"
          id="outbound-panel"
          role="tabpanel"
          aria-labelledby="outbound-tab"
        >
          <div class="section-header">
            <div>
              <h2>{{ t('outbound.title') }}</h2>
              <p class="section-subtitle">{{ t('outbound.description') }}</p>
            </div>
            <button
              class="btn btn-secondary btn-sm"
              :disabled="outboundLoading"
              @click="refreshOutbound"
            >
              <span v-if="outboundLoading" class="spinner" aria-hidden="true" />
              {{ t('outbound.refresh') }}
            </button>
          </div>

          <div class="notice-bar outbound-warning" role="note">
            <span class="notice-icon" aria-hidden="true">!</span>
            <span>{{ t('outbound.warning') }}</span>
          </div>

          <form class="card outbound-form" @submit.prevent="requestOutboundSend">
            <div class="form-grid">
              <label class="form-field">
                <span>{{ t('outbound.device') }}</span>
                <select
                  v-model="outboundDeviceId"
                  class="filter-select"
                  :disabled="outboundSendLoading || deviceDetails.length === 0"
                >
                  <option value="" disabled>{{ t('outbound.selectDevice') }}</option>
                  <option
                    v-for="device in activeDevices"
                    :key="device.deviceId"
                    :value="device.deviceId"
                  >
                    {{ device.description
                      ? `${device.deviceId} · ${device.description}`
                      : device.deviceId }}
                  </option>
                </select>
              </label>
              <label class="form-field">
                <span>{{ t('outbound.simLabel') }}</span>
                <select
                  v-model.number="outboundSlotIndex"
                  class="filter-select"
                  :disabled="outboundSendLoading"
                >
                  <option
                    v-for="line in outboundLines"
                    :key="line.slotIndex"
                    :value="line.slotIndex"
                  >
                    SIM{{ line.slotIndex + 1 }} ·
                    {{ line.carrierName || line.displayName || t('dashboard.unknown') }}
                  </option>
                </select>
              </label>
              <label class="form-field">
                <span>{{ t('outbound.recipient') }}</span>
                <input
                  v-model.trim="outboundRecipient"
                  class="form-input"
                  type="tel"
                  autocomplete="off"
                  :placeholder="t('outbound.recipientPlaceholder')"
                  :disabled="outboundSendLoading"
                >
              </label>
              <label class="form-field form-field-wide">
                <span>{{ t('outbound.body') }}</span>
                <textarea
                  v-model="outboundBody"
                  class="form-input outbound-body-input"
                  rows="4"
                  maxlength="2000"
                  :placeholder="t('outbound.bodyPlaceholder')"
                  :disabled="outboundSendLoading"
                />
                <small>{{ outboundBody.length }} / 2000</small>
              </label>
            </div>
            <p v-if="outboundSendError" class="inline-alert inline-alert-error" role="alert">
              {{ outboundSendError }}
            </p>
            <p
              v-if="selectedOutboundDevice && selectedOutboundDevice.health !== 'ONLINE'"
              class="inline-alert inline-alert-warning"
              role="status"
            >
              {{ t('outbound.deviceHealthWarning', {
                health: t(`fleet.health.${selectedOutboundDevice.health}`),
              }) }}
            </p>
            <button
              class="btn btn-primary"
              type="submit"
              :disabled="!canRequestOutboundSend || outboundSendLoading"
            >
              <span v-if="outboundSendLoading" class="spinner" aria-hidden="true" />
              {{ t('outbound.reviewSend') }}
            </button>
          </form>

          <div class="section-header outbound-history-heading">
            <div>
              <h3>{{ t('outbound.history') }}</h3>
              <p class="section-subtitle">
                {{ t('outbound.loadedSummary', { count: outboundMessages.length }) }}
              </p>
            </div>
          </div>

          <p v-if="outboundError" class="inline-alert inline-alert-warning" role="alert">
            {{ t('outbound.loadError') }}
          </p>
          <div v-if="outboundLoading && outboundMessages.length === 0" class="loading-state">
            <div class="spinner spinner-lg" aria-hidden="true" />
            <p>{{ t('common.loading') }}</p>
          </div>
          <div v-else-if="outboundMessages.length === 0" class="empty-state card">
            <div class="empty-state-icon" aria-hidden="true">—</div>
            <p>{{ t('outbound.empty') }}</p>
          </div>
          <div v-else class="messages-list">
            <OutboundMessageCard
              v-for="message in outboundMessages"
              :key="message.commandId"
              :message="message"
            />
          </div>
          <div v-if="outboundHasMore && outboundMessages.length" class="load-more-row">
            <button
              class="btn btn-secondary"
              :disabled="outboundLoading"
              @click="loadOlderOutbound"
            >
              <span v-if="outboundLoading" class="spinner" aria-hidden="true" />
              {{ t('messages.loadMore') }}
            </button>
          </div>
        </section>

        <section
          v-if="activeTab === 'push'"
          id="push-panel"
          role="tabpanel"
          aria-labelledby="push-tab"
        >
          <div class="section-header">
            <div>
              <h2>{{ t('push.title') }}</h2>
              <p class="section-subtitle">{{ t('push.description') }}</p>
            </div>
            <button
              class="btn btn-secondary btn-sm"
              :disabled="pushLoading"
              @click="loadNotificationSettings"
            >
              <span v-if="pushLoading" class="spinner" aria-hidden="true" />
              {{ t('push.refresh') }}
            </button>
          </div>

          <p v-if="pushError" class="inline-alert inline-alert-error" role="alert">
            {{ pushError }}
          </p>

          <div v-if="notificationSettings" class="card push-settings-card">
            <div class="status-items">
              <div class="status-item">
                <span class="status-label">{{ t('push.channel') }}</span>
                <strong>{{ t('push.feishu') }}</strong>
              </div>
              <div class="status-item">
                <span class="status-label">{{ t('push.configured') }}</span>
                <span :class="notificationSettings.configured ? 'text-success' : 'text-danger'">
                  {{ notificationSettings.configured ? t('push.yes') : t('push.no') }}
                </span>
              </div>
              <div class="status-item">
                <span class="status-label">{{ t('push.signing') }}</span>
                <span>{{ notificationSettings.signingEnabled ? t('push.enabled') : t('push.disabled') }}</span>
              </div>
            </div>

            <p
              v-if="!notificationSettings.configured"
              class="inline-alert inline-alert-warning"
              role="status"
            >
              {{ t('push.notConfigured') }}
            </p>

            <form class="push-settings-form" @submit.prevent="saveNotificationSettings">
              <label class="push-toggle">
                <input
                  v-model="pushEnabled"
                  type="checkbox"
                  :disabled="pushSaving || !notificationSettings.configured"
                >
                <span>
                  <strong>{{ t('push.enableDelivery') }}</strong>
                  <small>{{ t('push.enableHelp') }}</small>
                </span>
              </label>

              <fieldset class="form-field form-field-wide push-mode-field">
                <legend>{{ t('push.contentMode') }}</legend>
                <label class="push-mode-option">
                  <input v-model="pushContentMode" type="radio" value="REDACTED" :disabled="pushSaving">
                  <span>
                    <strong>{{ t('push.redacted') }}</strong>
                    <small>{{ t('push.redactedHelp') }}</small>
                  </span>
                </label>
                <label class="push-mode-option push-mode-danger">
                  <input v-model="pushContentMode" type="radio" value="FULL" :disabled="pushSaving">
                  <span>
                    <strong>{{ t('push.full') }}</strong>
                    <small>{{ t('push.fullHelp') }}</small>
                  </span>
                </label>
              </fieldset>

              <div class="form-actions">
                <button class="btn btn-primary" type="submit" :disabled="pushSaving">
                  <span v-if="pushSaving" class="spinner" aria-hidden="true" />
                  {{ t('push.save') }}
                </button>
                <button
                  class="btn btn-secondary"
                  type="button"
                  :disabled="pushTesting || !notificationSettings.configured"
                  @click="sendNotificationTest"
                >
                  <span v-if="pushTesting" class="spinner" aria-hidden="true" />
                  {{ t('push.test') }}
                </button>
              </div>
            </form>

            <div class="refresh-summary push-summary">
              <span>{{ t('push.pending') }}: {{ notificationSettings.pendingCount }}</span>
              <span>{{ t('push.retrying') }}: {{ notificationSettings.retryCount }}</span>
              <span>{{ t('push.lastSuccess') }}: {{ formatOptionalTime(notificationSettings.lastSuccessAt) }}</span>
              <span>{{ t('push.lastAttempt') }}: {{ formatOptionalTime(notificationSettings.lastAttemptAt) }}</span>
            </div>
          </div>
        </section>

        <section
          v-if="activeTab === 'devices'"
          id="devices-panel"
          role="tabpanel"
          aria-labelledby="devices-tab"
        >
          <div class="section-header">
            <div>
              <h2>{{ t('devices.title') }}</h2>
              <p class="section-subtitle">{{ t('devices.description') }}</p>
            </div>
            <div class="section-actions">
              <button class="btn btn-secondary btn-sm" :disabled="deviceLoading" @click="loadDevices">
                <span v-if="deviceLoading" class="spinner" aria-hidden="true" />
                {{ t('devices.refresh') }}
              </button>
              <button class="btn btn-primary btn-sm" @click="toggleAddDevice">
                {{ showAddDevice ? t('common.cancel') : t('devices.add') }}
              </button>
            </div>
          </div>

          <p v-if="deviceError" class="inline-alert inline-alert-error" role="alert">
            {{ deviceError }}
          </p>

          <form v-if="showAddDevice" class="card device-form" @submit.prevent="handleAddDevice">
            <h3 class="card-title">{{ t('devices.add') }}</h3>
            <div class="form-grid">
              <label class="form-field">
                <span>{{ t('devices.deviceId') }}</span>
                <input
                  v-model.trim="newDeviceId"
                  class="form-input"
                  type="text"
                  placeholder="my-device"
                  autocomplete="off"
                  :disabled="addDeviceLoading"
                >
              </label>
              <label class="form-field form-field-wide">
                <span>{{ t('devices.secret') }}</span>
                <div class="secret-field">
                  <input
                    v-model.trim="newDeviceSecret"
                    class="form-input"
                    :type="newSecretVisible ? 'text' : 'password'"
                    :placeholder="t('devices.secretPlaceholder')"
                    autocomplete="new-password"
                    :disabled="addDeviceLoading"
                  >
                  <button type="button" class="btn btn-secondary btn-sm" @click="newSecretVisible = !newSecretVisible">
                    {{ newSecretVisible ? t('messages.hide') : t('messages.show') }}
                  </button>
                </div>
                <small v-if="newDeviceSecret" :class="newSecretValidation.valid ? 'text-success' : 'text-danger'">
                  {{ secretValidationText(newSecretValidation) }}
                </small>
                <div class="secret-actions">
                  <button type="button" class="btn btn-ghost btn-sm" @click="generateNewSecret">
                    {{ t('devices.generateSecret') }}
                  </button>
                  <button v-if="newDeviceSecret" type="button" class="btn btn-ghost btn-sm" @click="copyText(newDeviceSecret)">
                    {{ t('devices.copySecret') }}
                  </button>
                </div>
              </label>
              <label class="form-field">
                <span>{{ t('devices.descriptionLabel') }}</span>
                <input
                  v-model.trim="newDeviceDescription"
                  class="form-input"
                  type="text"
                  :placeholder="t('devices.descriptionPlaceholder')"
                  :disabled="addDeviceLoading"
                >
              </label>
            </div>
            <p v-if="addDeviceError" class="inline-alert inline-alert-error" role="alert">
              {{ addDeviceError }}
            </p>
            <button
              class="btn btn-primary"
              type="submit"
              :disabled="addDeviceLoading || !newDeviceId || !newSecretValidation.valid"
            >
              <span v-if="addDeviceLoading" class="spinner" aria-hidden="true" />
              {{ addDeviceLoading ? t('devices.adding') : t('devices.confirmAdd') }}
            </button>
          </form>

          <div v-if="deviceLoading && deviceDetails.length === 0" class="loading-state">
            <div class="spinner spinner-lg" aria-hidden="true" />
            <p>{{ t('common.loading') }}</p>
          </div>
          <div v-else-if="deviceDetails.length === 0" class="empty-state card">
            <div class="empty-state-icon" aria-hidden="true">—</div>
            <p>{{ t('devices.empty') }}</p>
          </div>
          <div v-else class="device-list">
            <article v-for="device in deviceDetails" :key="device.deviceId" class="card device-item">
              <div class="device-row">
                <div class="device-info">
                  <strong>{{ device.deviceId }}</strong>
                  <span v-if="device.description">{{ device.description }}</span>
                  <span class="device-meta">
                    {{ t('devices.createdAt') }}: {{ formatTime(device.createdAt) }} ·
                    {{ t('devices.lastSeen') }}: {{ formatOptionalTime(device.lastSeenAt) }}
                  </span>
                  <span class="badge">{{ t(`fleet.health.${device.health}`) }}</span>
                  <span class="device-meta">
                    {{ device.status.manufacturer || '—' }}
                    {{ device.status.model || '' }} ·
                    {{ device.status.receiveMode || '—' }} ·
                    SDK {{ device.status.targetSdk ?? '—' }}
                  </span>
                  <span class="device-meta">
                    {{ t('fleet.permissions') }}:
                    RECEIVE_SMS={{ device.status.permissions.receiveSms ?? '—' }},
                    SEND_SMS={{ device.status.permissions.sendSms ?? '—' }},
                    READ_PHONE_STATE={{ device.status.permissions.readPhoneState ?? '—' }}
                  </span>
                  <span class="device-meta">
                    {{ t('devices.ordinarySmsObserved') }}:
                    {{ formatOptionalTime(device.status.lastOrdinarySmsAt) }} ·
                    {{ t('devices.otpObserved') }}:
                    {{ formatOptionalTime(device.status.lastOtpAt) }}
                  </span>
                  <span class="device-meta">
                    {{ t('devices.receiverInvoked') }}:
                    {{ device.status.lastReceiverInvokedAction || '—' }} ·
                    {{ formatOptionalTime(device.status.lastReceiverInvokedAt) }}
                  </span>
                  <p
                    v-if="
                      device.status.lastOtpAt !== null
                      && device.status.lastOrdinarySmsAt === null
                    "
                    class="inline-alert inline-alert-warning"
                    role="status"
                  >
                    {{ t('devices.otpOnlyWarning') }}
                  </p>
                  <p
                    v-if="hasUnresolvedReceiverParseFailure(device)"
                    class="inline-alert inline-alert-error"
                    role="alert"
                  >
                    {{ t('devices.receiverParseFailure', {
                      reason: t(
                        `devices.receiverFailureReasons.${device.status.lastReceiverParseFailureReason}`,
                      ),
                      time: formatOptionalTime(device.status.lastReceiverParseFailureAt),
                    }) }}
                  </p>
                </div>
                <div class="device-actions">
                  <button class="btn btn-primary btn-sm" :disabled="pairingLoading" @click="generatePairingForDevice(device.deviceId)">
                    {{ t('pairing.generate') }}
                  </button>
                  <button
                    v-if="device.retiredAt !== null"
                    class="btn btn-secondary btn-sm"
                    @click="handleRestoreDevice(device)"
                  >
                    {{ t('devices.restore') }}
                  </button>
                  <button class="btn btn-secondary btn-sm" @click="startEditDevice(device)">
                    {{ t('devices.edit') }}
                  </button>
                  <button
                    v-if="device.retiredAt === null"
                    class="btn btn-danger btn-sm"
                    @click="requestDeleteDevice(device)"
                  >
                    {{ t('devices.delete') }}
                  </button>
                  <button
                    v-else
                    class="btn btn-danger btn-sm"
                    @click="handlePurgeDevice(device)"
                  >
                    {{ t('devices.purge') }}
                  </button>
                </div>
              </div>

              <form v-if="editingDeviceId === device.deviceId" class="device-edit-form" @submit.prevent="handleUpdateDevice(device)">
                <label class="form-field">
                  <span>{{ t('devices.descriptionLabel') }}</span>
                  <input v-model.trim="editDescription" class="form-input" type="text">
                </label>
                <label class="form-field form-field-wide">
                  <span>{{ t('devices.rotateSecret') }}</span>
                  <div class="secret-field">
                    <input
                      v-model.trim="editSecret"
                      class="form-input"
                      :type="editSecretVisible ? 'text' : 'password'"
                      :placeholder="t('devices.rotateSecretPlaceholder')"
                      autocomplete="new-password"
                    >
                    <button type="button" class="btn btn-secondary btn-sm" @click="editSecretVisible = !editSecretVisible">
                      {{ editSecretVisible ? t('messages.hide') : t('messages.show') }}
                    </button>
                  </div>
                  <small v-if="editSecret" :class="editSecretValidation.valid ? 'text-success' : 'text-danger'">
                    {{ secretValidationText(editSecretValidation) }}
                  </small>
                  <div class="secret-actions">
                    <button type="button" class="btn btn-ghost btn-sm" @click="generateEditSecret">
                      {{ t('devices.generateSecret') }}
                    </button>
                    <button v-if="editSecret" type="button" class="btn btn-ghost btn-sm" @click="copyText(editSecret)">
                      {{ t('devices.copySecret') }}
                    </button>
                  </div>
                </label>
                <div class="form-actions">
                  <button class="btn btn-primary btn-sm" :disabled="editLoading || Boolean(editSecret && !editSecretValidation.valid)">
                    <span v-if="editLoading" class="spinner" aria-hidden="true" />
                    {{ t('common.save') }}
                  </button>
                  <button type="button" class="btn btn-secondary btn-sm" @click="cancelEditDevice">
                    {{ t('common.cancel') }}
                  </button>
                </div>
              </form>

              <div v-if="pairingDevice === device.deviceId && pairingQr" class="pairing-result" aria-live="polite">
                <img :src="pairingQr" :alt="t('pairing.qrAlt')" class="pairing-qr">
                <div class="pairing-instructions">
                  <strong>{{ t('pairing.scanNow') }}</strong>
                  <span>{{ pairingSeconds > 0
                    ? t('pairing.expiresIn', { seconds: pairingSeconds })
                    : t('pairing.expired') }}</span>
                  <small>{{ t('pairing.secretNotice') }}</small>
                  <button type="button" class="btn btn-ghost btn-sm" @click="clearPairing">
                    {{ t('common.close') }}
                  </button>
                </div>
              </div>
            </article>
          </div>

          <div class="section-header outbound-history-heading">
            <div>
              <h3>{{ t('groups.title') }}</h3>
              <p class="section-subtitle">{{ t('groups.description') }}</p>
            </div>
          </div>
          <form class="card device-form" @submit.prevent="handleCreateGroup">
            <div class="form-grid">
              <label class="form-field">
                <span>{{ t('groups.groupId') }}</span>
                <input
                  v-model.trim="newGroupId"
                  class="form-input"
                  maxlength="64"
                  pattern="[A-Za-z0-9._-]{1,64}"
                  autocomplete="off"
                  :disabled="groupMutationLoading !== null"
                  required
                >
              </label>
              <label class="form-field">
                <span>{{ t('groups.name') }}</span>
                <input
                  v-model.trim="newGroupName"
                  class="form-input"
                  maxlength="128"
                  autocomplete="off"
                  :disabled="groupMutationLoading !== null"
                  required
                >
              </label>
              <fieldset class="form-field form-field-wide group-members-field">
                <legend>{{ t('groups.members') }}</legend>
                <div v-if="deviceDetails.length" class="group-member-grid">
                  <label
                    v-for="device in deviceDetails"
                    :key="device.deviceId"
                    class="group-member-option"
                  >
                    <input
                      v-model="newGroupDeviceIds"
                      type="checkbox"
                      :value="device.deviceId"
                      :disabled="groupMutationLoading !== null"
                    >
                    <span>
                      <strong>{{ device.deviceId }}</strong>
                      <small>{{ t(`fleet.health.${device.health}`) }}</small>
                    </span>
                  </label>
                </div>
                <span v-else class="device-meta">{{ t('groups.noDevices') }}</span>
              </fieldset>
            </div>
            <button
              class="btn btn-primary"
              type="submit"
              :disabled="!canCreateGroup || groupMutationLoading !== null"
            >
              <span
                v-if="groupMutationLoading === 'create'"
                class="spinner"
                aria-hidden="true"
              />
              {{ groupMutationLoading === 'create'
                ? t('groups.creating')
                : t('groups.create') }}
            </button>
          </form>
          <div v-if="deviceGroups.length" class="device-list">
            <article v-for="group in deviceGroups" :key="group.groupId" class="card device-item">
              <div class="device-row">
                <div class="device-info">
                  <strong>{{ group.name }}</strong>
                  <span class="device-meta">{{ group.groupId }}</span>
                  <span class="device-meta">
                    {{ group.deviceIds.join(', ') || t('groups.noMembers') }}
                  </span>
                </div>
                <div class="device-actions">
                  <button
                    class="btn btn-secondary btn-sm"
                    :disabled="groupMutationLoading !== null"
                    @click="startEditGroup(group)"
                  >
                    {{ t('groups.edit') }}
                  </button>
                  <button
                    class="btn btn-danger btn-sm"
                    :disabled="groupMutationLoading !== null"
                    @click="handleDeleteGroup(group)"
                  >
                    {{ t('groups.delete') }}
                  </button>
                </div>
              </div>
              <form
                v-if="editingGroupId === group.groupId"
                class="device-edit-form"
                @submit.prevent="handleUpdateGroup(group)"
              >
                <label class="form-field">
                  <span>{{ t('groups.name') }}</span>
                  <input
                    v-model.trim="editGroupName"
                    class="form-input"
                    maxlength="128"
                    :disabled="groupMutationLoading !== null"
                    required
                  >
                </label>
                <fieldset class="form-field form-field-wide group-members-field">
                  <legend>{{ t('groups.members') }}</legend>
                  <div v-if="deviceDetails.length" class="group-member-grid">
                    <label
                      v-for="device in deviceDetails"
                      :key="device.deviceId"
                      class="group-member-option"
                    >
                      <input
                        v-model="editGroupDeviceIds"
                        type="checkbox"
                        :value="device.deviceId"
                        :disabled="groupMutationLoading !== null"
                      >
                      <span>
                        <strong>{{ device.deviceId }}</strong>
                        <small>{{ t(`fleet.health.${device.health}`) }}</small>
                      </span>
                    </label>
                  </div>
                  <span v-else class="device-meta">{{ t('groups.noDevices') }}</span>
                </fieldset>
                <div class="form-actions">
                  <button
                    class="btn btn-primary btn-sm"
                    :disabled="!editGroupName || groupMutationLoading !== null"
                  >
                    <span
                      v-if="groupMutationLoading === group.groupId"
                      class="spinner"
                      aria-hidden="true"
                    />
                    {{ groupMutationLoading === group.groupId
                      ? t('groups.saving')
                      : t('common.save') }}
                  </button>
                  <button
                    type="button"
                    class="btn btn-secondary btn-sm"
                    :disabled="groupMutationLoading !== null"
                    @click="cancelEditGroup"
                  >
                    {{ t('common.cancel') }}
                  </button>
                </div>
              </form>
            </article>
          </div>
          <div v-else class="empty-state card">
            <div class="empty-state-icon" aria-hidden="true">—</div>
            <p>{{ t('groups.empty') }}</p>
          </div>

          <div class="section-header outbound-history-heading">
            <div>
              <h3>{{ t('devices.auditTitle') }}</h3>
              <p class="section-subtitle">{{ t('devices.auditDescription') }}</p>
            </div>
          </div>
          <div v-if="auditEntries.length" class="device-list">
            <article v-for="entry in auditEntries" :key="entry.id" class="card device-item">
              <strong>{{ entry.action }}</strong>
              <span class="device-meta">
                {{ entry.deviceId || '—' }} · {{ entry.clientId }} ·
                {{ formatTime(entry.occurredAt) }} · {{ entry.outcome }}
              </span>
            </article>
          </div>
        </section>
      </div>
    </main>

    <AdminConfirmDialog
      :open="Boolean(pendingOutbound)"
      :title="t('outbound.confirmTitle')"
      :message="t('outbound.confirmMessage', {
        deviceId: pendingOutbound?.deviceId || '',
        sim: (pendingOutbound?.slotIndex ?? 0) + 1,
        recipient: pendingOutbound?.recipient || '',
      })"
      :confirm-label="t('outbound.confirmSend')"
      :cancel-label="t('common.cancel')"
      :busy="outboundSendLoading"
      @confirm="confirmOutboundSend"
      @cancel="pendingOutbound = null"
    />

    <AdminConfirmDialog
      :open="Boolean(pendingDeleteDevice)"
      :title="t('devices.deleteDialogTitle')"
      :message="t('devices.deleteConfirm', { deviceId: pendingDeleteDevice?.deviceId || '' })"
      :confirm-label="t('devices.delete')"
      :cancel-label="t('common.cancel')"
      :busy="deleteLoading"
      danger
      @confirm="confirmDeleteDevice"
      @cancel="pendingDeleteDevice = null"
    />

    <AdminToast
      :message="toast.message"
      :tone="toast.tone"
      :close-label="t('common.close')"
      @close="clearToast"
    />
  </div>
</template>

<script setup lang="ts">
import QRCode from 'qrcode'
import type {
  GatewayAuditEntry,
  GatewayDeviceGroup,
  GatewayDeviceDetail,
  GatewayMessage,
  GatewayNotification,
  GatewayNotificationSettings,
} from '~/composables/useGateway'
import {
  generateDeviceSecret,
  validateDeviceSecret,
} from '~/utils/deviceSecret'
import type { SecretValidation } from '~/utils/deviceSecret'

type AdminTab = 'dashboard' | 'messages' | 'outbound' | 'push' | 'devices'
type ContentFilter = 'all' | 'sms' | 'notifications'
type DateRange = 'all' | 'today' | '7d' | '30d'
type GatewayFilter = { deviceId?: string; groupId?: string }
type TimelineItem =
  | { kind: 'sms'; key: string; receivedAt: number; message: GatewayMessage }
  | { kind: 'notification'; key: string; receivedAt: number; notification: GatewayNotification }

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const { logout } = useAuth()
const {
  status,
  messages,
  notifications,
  outboundMessages,
  messageLoading,
  notificationLoading,
  outboundLoading,
  messageHasMore,
  notificationHasMore,
  outboundHasMore,
  statusLastSuccessAt,
  messageLastSuccessAt,
  notificationLastSuccessAt,
  statusError,
  messageError,
  notificationError,
  outboundError,
  simCounts,
  latestMessageTime,
  fetchStatus,
  fetchMessages,
  fetchNotifications,
  fetchOutboundMessages,
  sendOutboundMessage,
  fetchDeviceDetails,
  addDevice,
  updateDevice,
  removeDevice,
  restoreDevice,
  purgeDevice,
  fetchAuditLog,
  fetchNotificationSettings,
  updateNotificationSettings,
  testNotification,
  fetchDeviceGroups,
  createDeviceGroup,
  updateDeviceGroup,
  removeDeviceGroup,
  createPairing,
} = useGateway()

const tabs: Array<{ id: AdminTab; label: string }> = [
  { id: 'dashboard', label: 'nav.dashboard' },
  { id: 'messages', label: 'nav.messages' },
  { id: 'outbound', label: 'nav.outbound' },
  { id: 'push', label: 'nav.push' },
  { id: 'devices', label: 'nav.devices' },
]
const tabRefs = new Map<AdminTab, HTMLButtonElement>()
const initialTab = route.query.view
const activeTab = ref<AdminTab>(
  initialTab === 'messages'
  || initialTab === 'outbound'
  || initialTab === 'push'
  || initialTab === 'devices'
    ? initialTab
    : 'dashboard',
)
const contentFilter = ref<ContentFilter>(
  route.query.type === 'sms' || route.query.type === 'notifications'
    ? route.query.type
    : 'all',
)
const currentFilter = ref<number | null>(
  route.query.sim === '0' ? 0 : route.query.sim === '1' ? 1 : null,
)
const sourcePackageFilter = ref(typeof route.query.source === 'string' ? route.query.source : '')
const searchQuery = ref(typeof route.query.q === 'string' ? route.query.q : '')
const dateRange = ref<DateRange>(
  ['today', '7d', '30d'].includes(String(route.query.range))
    ? route.query.range as DateRange
    : 'all',
)

function gatewayContextFromRoute(): string {
  const groupId = typeof route.query.group === 'string'
    ? route.query.group
    : ''
  if (/^[A-Za-z0-9._-]{1,64}$/.test(groupId)) return `group:${groupId}`
  const deviceId = typeof route.query.device === 'string'
    ? route.query.device
    : ''
  return /^[A-Za-z0-9._-]{1,64}$/.test(deviceId) ? deviceId : 'all'
}

const selectedDeviceId = ref(gatewayContextFromRoute())

const deviceDetails = ref<GatewayDeviceDetail[]>([])
const auditEntries = ref<GatewayAuditEntry[]>([])
const deviceGroups = ref<GatewayDeviceGroup[]>([])
const newGroupId = ref('')
const newGroupName = ref('')
const newGroupDeviceIds = ref<string[]>([])
const editingGroupId = ref<string | null>(null)
const editGroupName = ref('')
const editGroupDeviceIds = ref<string[]>([])
const groupMutationLoading = ref<string | null>(null)
const deviceLoading = ref(false)
const deviceError = ref('')
const dashboardRefreshing = ref(false)
const notificationSettings = ref<GatewayNotificationSettings | null>(null)
const pushEnabled = ref(false)
const pushContentMode = ref<'REDACTED' | 'FULL'>('REDACTED')
const pushLoading = ref(false)
const pushSaving = ref(false)
const pushTesting = ref(false)
const pushError = ref('')

const outboundDeviceId = ref('')
const outboundSlotIndex = ref(0)
const outboundRecipient = ref('')
const outboundBody = ref('')
const outboundSendLoading = ref(false)
const outboundSendError = ref('')
const pendingOutbound = ref<{
  deviceId: string
  slotIndex: number
  recipient: string
  body: string
} | null>(null)

const showAddDevice = ref(false)
const newDeviceId = ref('')
const newDeviceSecret = ref('')
const newDeviceDescription = ref('')
const newSecretVisible = ref(false)
const addDeviceLoading = ref(false)
const addDeviceError = ref('')

const editingDeviceId = ref<string | null>(null)
const editDescription = ref('')
const editSecret = ref('')
const editSecretVisible = ref(false)
const editLoading = ref(false)
const pendingDeleteDevice = ref<GatewayDeviceDetail | null>(null)
const deleteLoading = ref(false)

const pairingDevice = ref('')
const pairingQr = ref('')
const pairingExpiresAt = ref(0)
const pairingNow = ref(Date.now())
const pairingLoading = ref(false)
let pairingTimer: ReturnType<typeof setInterval> | null = null

const revealAll = ref(false)
const privacySeconds = ref(0)
let privacyTimer: ReturnType<typeof setInterval> | null = null

const toast = reactive<{
  message: string
  tone: 'success' | 'error' | 'info'
}>({ message: '', tone: 'info' })
let toastTimer: ReturnType<typeof setTimeout> | null = null

const contentLoading = computed(() => messageLoading.value || notificationLoading.value)
const activeDevices = computed(() =>
  deviceDetails.value.filter(device => device.retiredAt === null),
)
const selectedOutboundDevice = computed(() =>
  deviceDetails.value.find(device => device.deviceId === outboundDeviceId.value) ?? null,
)
const outboundLines = computed(() =>
  selectedOutboundDevice.value?.status.lines.filter(line => line.active) ?? [],
)
const currentGatewayFilter = computed<GatewayFilter>(() => {
  if (selectedDeviceId.value.startsWith('group:')) {
    return { groupId: selectedDeviceId.value.slice('group:'.length) }
  }
  if (selectedDeviceId.value !== 'all') {
    return { deviceId: selectedDeviceId.value }
  }
  return {}
})
const canCreateGroup = computed(() =>
  /^[A-Za-z0-9._-]{1,64}$/.test(newGroupId.value)
  && newGroupName.value.length > 0
  && newGroupName.value.length <= 128,
)
const canRequestOutboundSend = computed(() =>
  Boolean(outboundDeviceId.value)
  && outboundLines.value.some(line => line.slotIndex === outboundSlotIndex.value)
  && outboundRecipient.value.length > 0
  && outboundRecipient.value.length <= 64
  && !/[A-Za-z]/.test(outboundRecipient.value)
  && outboundBody.value.length > 0
  && outboundBody.value.length <= 2_000,
)
const postedNotifications = computed(() =>
  notifications.value.filter(notification => notification.eventType === 'POSTED'),
)
const notificationSources = computed(() =>
  [...new Set(
    postedNotifications.value
      .map(notification => notification.sourcePackage)
      .filter((value): value is string => Boolean(value)),
  )].sort(),
)
const latestNotificationTime = computed(() => {
  if (postedNotifications.value.length === 0) return null
  return Math.max(...postedNotifications.value.map(item => item.receivedAt))
})
const latestDeviceActivity = computed(() => {
  const values = deviceDetails.value
    .map(device => device.lastSeenAt)
    .filter((value): value is number => value !== null)
  return values.length ? Math.max(...values) : null
})
const pairingSeconds = computed(() =>
  Math.max(0, Math.ceil((pairingExpiresAt.value - pairingNow.value) / 1000)),
)
const newSecretValidation = computed(() => validateDeviceSecret(newDeviceSecret.value))
const editSecretValidation = computed(() => validateDeviceSecret(editSecret.value))

const contentFilterOptions = computed(() => [
  { value: 'all' as const, label: 'messages.filter.all', count: messages.value.length + postedNotifications.value.length },
  { value: 'sms' as const, label: 'messages.filter.sms', count: messages.value.length },
  { value: 'notifications' as const, label: 'messages.filter.notifications', count: postedNotifications.value.length },
])

const dateCutoff = computed(() => {
  const now = new Date()
  if (dateRange.value === 'today') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  }
  if (dateRange.value === '7d') return Date.now() - 7 * 86_400_000
  if (dateRange.value === '30d') return Date.now() - 30 * 86_400_000
  return null
})

const filteredTimeline = computed<TimelineItem[]>(() => {
  const timeline: TimelineItem[] = []
  const search = searchQuery.value.toLocaleLowerCase()
  const after = dateCutoff.value

  if (contentFilter.value !== 'notifications') {
    messages.value
      .filter(message => currentFilter.value === null || message.slotIndex === currentFilter.value)
      .filter(message => after === null || message.receivedAt >= after)
      .filter(message => !search || [message.sender, message.body, message.deviceId]
        .some(value => value?.toLocaleLowerCase().includes(search)))
      .forEach((message) => timeline.push({
        kind: 'sms',
        key: `sms-${message.id}`,
        receivedAt: message.receivedAt,
        message,
      }))
  }

  if (contentFilter.value !== 'sms') {
    postedNotifications.value
      .filter(notification => !sourcePackageFilter.value || notification.sourcePackage === sourcePackageFilter.value)
      .filter(notification => after === null || notification.receivedAt >= after)
      .filter(notification => !search || [
        notification.title,
        notification.body,
        notification.sourcePackage,
        notification.deviceId,
      ].some(value => value?.toLocaleLowerCase().includes(search)))
      .forEach((notification) => timeline.push({
        kind: 'notification',
        key: `notification-${notification.id}`,
        receivedAt: notification.receivedAt,
        notification,
      }))
  }

  return timeline.sort((left, right) => right.receivedAt - left.receivedAt)
})

const hasActiveFilters = computed(() =>
  contentFilter.value !== 'all'
  || currentFilter.value !== null
  || Boolean(sourcePackageFilter.value)
  || Boolean(searchQuery.value)
  || dateRange.value !== 'all',
)
const emptyStateText = computed(() => {
  if (contentFilter.value === 'sms' && currentFilter.value !== null) {
    return t('messages.emptySmsForSim', { sim: currentFilter.value + 1 })
  }
  if (contentFilter.value === 'notifications' && sourcePackageFilter.value) {
    return t('messages.emptyNotificationsForSource', { source: sourcePackageFilter.value })
  }
  return t('messages.empty')
})
const canLoadMore = computed(() => {
  if (contentFilter.value === 'sms') {
    return messages.value.length > 0 && messageHasMore.value
  }
  if (contentFilter.value === 'notifications') {
    return notifications.value.length > 0 && notificationHasMore.value
  }
  return (messages.value.length > 0 && messageHasMore.value)
    || (notifications.value.length > 0 && notificationHasMore.value)
})

watch(contentFilter, (value) => {
  if (value === 'sms') sourcePackageFilter.value = ''
  if (value === 'notifications') currentFilter.value = null
})
watch(notificationSources, (sources) => {
  if (sourcePackageFilter.value && !sources.includes(sourcePackageFilter.value)) {
    sourcePackageFilter.value = ''
  }
})
watch(deviceDetails, (devices) => {
  if (!devices.some(device =>
    device.deviceId === outboundDeviceId.value && device.retiredAt === null)) {
    outboundDeviceId.value = ''
  }
  if (
    selectedDeviceId.value !== 'all'
    && !selectedDeviceId.value.startsWith('group:')
    && !devices.some(device => device.deviceId === selectedDeviceId.value)
  ) selectedDeviceId.value = 'all'
})
watch(deviceGroups, (groups) => {
  if (
    selectedDeviceId.value.startsWith('group:')
    && !groups.some(
      group => `group:${group.groupId}` === selectedDeviceId.value,
    )
  ) selectedDeviceId.value = 'all'
})
watch(
  () => [route.query.device, route.query.group],
  () => {
    const routeContext = gatewayContextFromRoute()
    if (routeContext !== selectedDeviceId.value) {
      selectedDeviceId.value = routeContext
    }
  },
)
watch(outboundDeviceId, () => {
  outboundSlotIndex.value = outboundLines.value[0]?.slotIndex ?? -1
})
watch(selectedDeviceId, async () => {
  hideAllSensitive()
  currentFilter.value = null
  await Promise.all([
    fetchMessages({ limit: 50, ...currentGatewayFilter.value }),
    fetchNotifications({ limit: 50, ...currentGatewayFilter.value }),
    fetchOutboundMessages({ limit: 50, ...currentGatewayFilter.value }),
  ])
})
watch(activeTab, (tab) => {
  if (tab !== 'messages') hideAllSensitive()
  if (tab === 'push' && notificationSettings.value === null) {
    void loadNotificationSettings()
  }
})
watch(
  [
    activeTab,
    contentFilter,
    currentFilter,
    sourcePackageFilter,
    searchQuery,
    dateRange,
    selectedDeviceId,
  ],
  () => {
    const query: Record<string, string> = {}
    if (activeTab.value !== 'dashboard') query.view = activeTab.value
    if (selectedDeviceId.value.startsWith('group:')) {
      query.group = selectedDeviceId.value.slice('group:'.length)
    } else if (selectedDeviceId.value !== 'all') {
      query.device = selectedDeviceId.value
    }
    if (activeTab.value === 'messages') {
      if (contentFilter.value !== 'all') query.type = contentFilter.value
      if (currentFilter.value !== null) query.sim = String(currentFilter.value)
      if (sourcePackageFilter.value) query.source = sourcePackageFilter.value
      if (searchQuery.value) query.q = searchQuery.value
      if (dateRange.value !== 'all') query.range = dateRange.value
    }
    void router.replace({ query })
  },
)

onMounted(async () => {
  await refreshDashboard(true)
  if (activeTab.value === 'push') await loadNotificationSettings()
  pairingTimer = setInterval(() => {
    pairingNow.value = Date.now()
    if (pairingExpiresAt.value && pairingSeconds.value <= 0) pairingQr.value = ''
  }, 1000)
})

onBeforeUnmount(() => {
  if (pairingTimer) clearInterval(pairingTimer)
  if (privacyTimer) clearInterval(privacyTimer)
  if (toastTimer) clearTimeout(toastTimer)
})

function setTabRef(tab: AdminTab, element: Element | ComponentPublicInstance | null): void {
  if (element instanceof HTMLButtonElement) tabRefs.set(tab, element)
}

function selectTab(tab: AdminTab): void {
  activeTab.value = tab
}

function handleTabKeydown(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const currentIndex = tabs.findIndex(tab => tab.id === activeTab.value)
  let nextIndex = currentIndex
  if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length
  if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length
  if (event.key === 'Home') nextIndex = 0
  if (event.key === 'End') nextIndex = tabs.length - 1
  selectTab(tabs[nextIndex].id)
  nextTick(() => tabRefs.get(tabs[nextIndex].id)?.focus())
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(timestamp))
}

function formatOptionalTime(timestamp: number | null | undefined): string {
  return timestamp ? formatTime(timestamp) : t('dashboard.never')
}

function hasUnresolvedReceiverParseFailure(
  device: GatewayDeviceDetail,
): boolean {
  const failureAt = device.status.lastReceiverParseFailureAt
  if (failureAt === null) return false
  return (
    device.status.lastIncomingSmsAt === null
    || failureAt > device.status.lastIncomingSmsAt
  )
}

async function refreshDashboard(silent = false): Promise<void> {
  dashboardRefreshing.value = true
  const results = await Promise.all([
    fetchStatus(),
    fetchMessages({ limit: 50, ...currentGatewayFilter.value }),
    fetchNotifications({ limit: 50, ...currentGatewayFilter.value }),
    fetchOutboundMessages({ limit: 20, ...currentGatewayFilter.value }),
    loadDevices(),
  ])
  dashboardRefreshing.value = false
  const successes = results.filter(Boolean).length
  if (!silent) {
    if (successes === results.length) showToast(t('common.refreshSuccess'), 'success')
    else if (successes > 0) showToast(t('common.partialRefresh'), 'info')
    else showToast(t('common.refreshFailed'), 'error')
  }
}

async function refreshContent(): Promise<void> {
  const jobs: Array<Promise<boolean>> = []
  if (contentFilter.value !== 'notifications') {
    jobs.push(fetchMessages({ limit: 50, ...currentGatewayFilter.value }))
  }
  if (contentFilter.value !== 'sms') {
    jobs.push(fetchNotifications({ limit: 50, ...currentGatewayFilter.value }))
  }
  const results = await Promise.all(jobs)
  const successes = results.filter(Boolean).length
  if (successes === results.length) showToast(t('common.refreshSuccess'), 'success')
  else if (successes > 0) showToast(t('common.partialRefresh'), 'info')
  else showToast(t('common.refreshFailed'), 'error')
}

async function refreshOutbound(): Promise<void> {
  const success = await fetchOutboundMessages({
    limit: 50,
    ...currentGatewayFilter.value,
  })
  showToast(
    success ? t('common.refreshSuccess') : t('common.refreshFailed'),
    success ? 'success' : 'error',
  )
}

async function loadOlderOutbound(): Promise<void> {
  if (!outboundMessages.value.length || !outboundHasMore.value) return
  await fetchOutboundMessages({
    limit: 50,
    beforeId: Math.min(...outboundMessages.value.map(message => message.id)),
    ...currentGatewayFilter.value,
    append: true,
  })
}

function requestOutboundSend(): void {
  outboundSendError.value = ''
  if (!canRequestOutboundSend.value) {
    outboundSendError.value = t('outbound.invalidRequest')
    return
  }
  pendingOutbound.value = {
    deviceId: outboundDeviceId.value,
    slotIndex: outboundSlotIndex.value,
    recipient: outboundRecipient.value,
    body: outboundBody.value,
  }
}

async function confirmOutboundSend(): Promise<void> {
  const request = pendingOutbound.value
  if (!request) return
  outboundSendLoading.value = true
  outboundSendError.value = ''
  try {
    await sendOutboundMessage({
      ...request,
      expiresInSeconds: 300,
      idempotencyKey: crypto.randomUUID(),
    })
    pendingOutbound.value = null
    outboundRecipient.value = ''
    outboundBody.value = ''
    showToast(t('outbound.sendQueued'), 'success')
    await fetchOutboundMessages({
      limit: 50,
      ...currentGatewayFilter.value,
    })
  } catch (error) {
    pendingOutbound.value = null
    outboundSendError.value = gatewayErrorText(
      error,
      t('outbound.sendError'),
    )
    showToast(outboundSendError.value, 'error')
  } finally {
    outboundSendLoading.value = false
  }
}

async function retryMessages(): Promise<void> {
  await fetchMessages({
    limit: 50,
    ...currentGatewayFilter.value,
  })
}

async function retryNotifications(): Promise<void> {
  await fetchNotifications({
    limit: 50,
    ...currentGatewayFilter.value,
  })
}

async function loadMore(): Promise<void> {
  const jobs: Array<Promise<boolean>> = []
  if (contentFilter.value !== 'notifications' && messageHasMore.value && messages.value.length) {
    jobs.push(fetchMessages({
      limit: 50,
      beforeId: Math.min(...messages.value.map(message => message.id)),
      ...currentGatewayFilter.value,
      append: true,
    }))
  }
  if (contentFilter.value !== 'sms' && notificationHasMore.value && notifications.value.length) {
    jobs.push(fetchNotifications({
      limit: 50,
      beforeId: Math.min(...notifications.value.map(notification => notification.id)),
      ...currentGatewayFilter.value,
      append: true,
    }))
  }
  await Promise.all(jobs)
}

function resetFilters(): void {
  contentFilter.value = 'all'
  currentFilter.value = null
  sourcePackageFilter.value = ''
  searchQuery.value = ''
  dateRange.value = 'all'
}

function toggleRevealAll(): void {
  if (revealAll.value) {
    hideAllSensitive()
    return
  }
  revealAll.value = true
  privacySeconds.value = 30
  if (privacyTimer) clearInterval(privacyTimer)
  privacyTimer = setInterval(() => {
    privacySeconds.value -= 1
    if (privacySeconds.value <= 0) hideAllSensitive()
  }, 1000)
}

function hideAllSensitive(): void {
  revealAll.value = false
  privacySeconds.value = 0
  if (privacyTimer) clearInterval(privacyTimer)
  privacyTimer = null
}

async function loadNotificationSettings(): Promise<void> {
  pushLoading.value = true
  pushError.value = ''
  try {
    const settings = await fetchNotificationSettings()
    notificationSettings.value = settings
    pushEnabled.value = settings.enabled
    pushContentMode.value = settings.contentMode
  } catch (error) {
    pushError.value = gatewayErrorText(error, t('push.loadError'))
  } finally {
    pushLoading.value = false
  }
}

async function saveNotificationSettings(): Promise<void> {
  pushSaving.value = true
  pushError.value = ''
  try {
    const settings = await updateNotificationSettings({
      enabled: pushEnabled.value,
      contentMode: pushContentMode.value,
    })
    notificationSettings.value = settings
    showToast(t('push.saveSuccess'), 'success')
  } catch (error) {
    pushError.value = gatewayErrorText(error, t('push.saveError'))
    showToast(pushError.value, 'error')
  } finally {
    pushSaving.value = false
  }
}

async function sendNotificationTest(): Promise<void> {
  pushTesting.value = true
  pushError.value = ''
  try {
    await testNotification()
    showToast(t('push.testQueued'), 'success')
    window.setTimeout(() => void loadNotificationSettings(), 1_500)
  } catch (error) {
    pushError.value = gatewayErrorText(error, t('push.testError'))
    showToast(pushError.value, 'error')
  } finally {
    pushTesting.value = false
  }
}

async function loadDevices(): Promise<boolean> {
  deviceLoading.value = true
  try {
    const [devices, audit, groups] = await Promise.all([
      fetchDeviceDetails(),
      fetchAuditLog(),
      fetchDeviceGroups(),
    ])
    deviceDetails.value = devices
    auditEntries.value = audit
    deviceGroups.value = groups
    deviceError.value = ''
    return true
  } catch {
    deviceError.value = t('devices.loadError')
    return false
  } finally {
    deviceLoading.value = false
  }
}

async function handleCreateGroup(): Promise<void> {
  if (!canCreateGroup.value || groupMutationLoading.value !== null) return
  groupMutationLoading.value = 'create'
  try {
    await createDeviceGroup({
      groupId: newGroupId.value,
      name: newGroupName.value,
      deviceIds: newGroupDeviceIds.value,
    })
    newGroupId.value = ''
    newGroupName.value = ''
    newGroupDeviceIds.value = []
    showToast(t('groups.createSuccess'), 'success')
    await loadDevices()
  } catch (error) {
    showToast(gatewayErrorText(error, t('groups.saveError')), 'error')
  } finally {
    groupMutationLoading.value = null
  }
}

function startEditGroup(group: GatewayDeviceGroup): void {
  editingGroupId.value = group.groupId
  editGroupName.value = group.name
  editGroupDeviceIds.value = [...group.deviceIds]
}

function cancelEditGroup(): void {
  editingGroupId.value = null
  editGroupName.value = ''
  editGroupDeviceIds.value = []
}

async function handleUpdateGroup(group: GatewayDeviceGroup): Promise<void> {
  if (
    !editGroupName.value
    || editGroupName.value.length > 128
    || groupMutationLoading.value !== null
  ) return
  groupMutationLoading.value = group.groupId
  try {
    await updateDeviceGroup(group.groupId, {
      name: editGroupName.value,
      deviceIds: editGroupDeviceIds.value,
    })
    cancelEditGroup()
    showToast(t('groups.updateSuccess'), 'success')
    await loadDevices()
  } catch (error) {
    showToast(gatewayErrorText(error, t('groups.saveError')), 'error')
  } finally {
    groupMutationLoading.value = null
  }
}

async function handleDeleteGroup(group: GatewayDeviceGroup): Promise<void> {
  if (groupMutationLoading.value !== null) return
  if (!window.confirm(t('groups.deleteConfirm', { name: group.name }))) return
  groupMutationLoading.value = group.groupId
  try {
    await removeDeviceGroup(group.groupId)
    if (selectedDeviceId.value === `group:${group.groupId}`) {
      selectedDeviceId.value = 'all'
    }
    if (editingGroupId.value === group.groupId) cancelEditGroup()
    showToast(t('groups.deleteSuccess'), 'success')
    await loadDevices()
  } catch (error) {
    showToast(gatewayErrorText(error, t('groups.deleteError')), 'error')
  } finally {
    groupMutationLoading.value = null
  }
}

async function handleRestoreDevice(device: GatewayDeviceDetail): Promise<void> {
  try {
    await restoreDevice(device.deviceId)
    showToast(t('devices.restoreSuccess'), 'success')
    await loadDevices()
  } catch (error) {
    showToast(gatewayErrorText(error, t('devices.restoreError')), 'error')
  }
}

async function handlePurgeDevice(device: GatewayDeviceDetail): Promise<void> {
  const expected = `PURGE ${device.deviceId}`
  const supplied = window.prompt(t('devices.purgePrompt', { confirmation: expected }))
  if (supplied !== expected) return
  try {
    await purgeDevice(device.deviceId)
    showToast(t('devices.purgeSuccess'), 'success')
    await loadDevices()
  } catch (error) {
    showToast(gatewayErrorText(error, t('devices.purgeError')), 'error')
  }
}

function toggleAddDevice(): void {
  showAddDevice.value = !showAddDevice.value
  if (!showAddDevice.value) resetAddDeviceForm()
}

function resetAddDeviceForm(): void {
  newDeviceId.value = ''
  newDeviceSecret.value = ''
  newDeviceDescription.value = ''
  newSecretVisible.value = false
  addDeviceError.value = ''
}

function generateNewSecret(): void {
  newDeviceSecret.value = generateDeviceSecret()
  newSecretVisible.value = true
}

function generateEditSecret(): void {
  editSecret.value = generateDeviceSecret()
  editSecretVisible.value = true
}

async function handleAddDevice(): Promise<void> {
  if (!newDeviceId.value || !newSecretValidation.value.valid) return
  addDeviceLoading.value = true
  addDeviceError.value = ''
  try {
    await addDevice({
      deviceId: newDeviceId.value,
      secretBase64: newDeviceSecret.value,
      description: newDeviceDescription.value,
    })
    showToast(t('devices.addSuccess'), 'success')
    resetAddDeviceForm()
    showAddDevice.value = false
    await loadDevices()
  } catch (error) {
    addDeviceError.value = gatewayErrorText(error, t('devices.addError'))
  } finally {
    addDeviceLoading.value = false
  }
}

function startEditDevice(device: GatewayDeviceDetail): void {
  editingDeviceId.value = device.deviceId
  editDescription.value = device.description
  editSecret.value = ''
  editSecretVisible.value = false
}

function cancelEditDevice(): void {
  editingDeviceId.value = null
  editDescription.value = ''
  editSecret.value = ''
}

async function handleUpdateDevice(device: GatewayDeviceDetail): Promise<void> {
  if (editSecret.value && !editSecretValidation.value.valid) return
  const options: { description?: string; secretBase64?: string } = {}
  if (editDescription.value !== device.description) options.description = editDescription.value
  if (editSecret.value) options.secretBase64 = editSecret.value
  if (Object.keys(options).length === 0) {
    cancelEditDevice()
    return
  }
  editLoading.value = true
  try {
    await updateDevice(device.deviceId, options)
    showToast(t('devices.updateSuccess'), 'success')
    cancelEditDevice()
    await loadDevices()
  } catch (error) {
    showToast(gatewayErrorText(error, t('devices.updateError')), 'error')
  } finally {
    editLoading.value = false
  }
}

function requestDeleteDevice(device: GatewayDeviceDetail): void {
  pendingDeleteDevice.value = device
}

async function confirmDeleteDevice(): Promise<void> {
  const device = pendingDeleteDevice.value
  if (!device) return
  deleteLoading.value = true
  try {
    await removeDevice(device.deviceId)
    if (pairingDevice.value === device.deviceId) clearPairing()
    pendingDeleteDevice.value = null
    showToast(t('devices.deleteSuccess'), 'success')
    await loadDevices()
  } catch (error) {
    showToast(gatewayErrorText(error, t('devices.deleteError')), 'error')
  } finally {
    deleteLoading.value = false
  }
}

async function generatePairingForDevice(deviceId: string): Promise<void> {
  pairingLoading.value = true
  pairingDevice.value = deviceId
  pairingQr.value = ''
  try {
    const result = await createPairing({ deviceId, expiresInSeconds: 300 })
    pairingQr.value = await QRCode.toDataURL(result.pairing.payload, {
      width: 320,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b1220', light: '#ffffff' },
    })
    pairingExpiresAt.value = result.pairing.expiresAt
    pairingNow.value = Date.now()
    showToast(t('pairing.generateSuccess'), 'success')
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode
    showToast(
      statusCode === 429 ? t('pairing.rateLimited') : t('pairing.generateError'),
      'error',
    )
  } finally {
    pairingLoading.value = false
  }
}

function clearPairing(): void {
  pairingDevice.value = ''
  pairingQr.value = ''
  pairingExpiresAt.value = 0
}

function secretValidationText(validation: SecretValidation): string {
  if (validation.valid) return t('devices.secretValid', { bytes: validation.decodedBytes })
  if (validation.reason === 'length') {
    return t('devices.secretTooShort', { bytes: validation.decodedBytes })
  }
  return t('devices.secretInvalid')
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
    showToast(t('common.copied'), 'success')
  } catch {
    showToast(t('common.copyFailed'), 'error')
  }
}

function gatewayErrorText(error: unknown, fallback: string): string {
  const value = error as { data?: { message?: string } }
  return value.data?.message || fallback
}

function showToast(message: string, tone: 'success' | 'error' | 'info'): void {
  toast.message = message
  toast.tone = tone
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(clearToast, 4_000)
}

function clearToast(): void {
  toast.message = ''
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = null
}

async function handleLogout(): Promise<void> {
  hideAllSensitive()
  await logout()
}
</script>

<style scoped>
.dashboard-layout { min-height: 100vh; display: flex; flex-direction: column; }
.navbar { position: sticky; top: 0; z-index: 50; padding: 0.75rem 0; background: var(--color-bg-card); border-bottom: 1px solid var(--color-border); }
.navbar-content, .navbar-menu, .navbar-tabs, .navbar-actions, .section-header, .section-actions, .card-heading, .device-row, .device-actions, .filter-row, .secret-field, .secret-actions, .form-actions, .refresh-summary { display: flex; align-items: center; }
.navbar-content, .section-header, .card-heading, .device-row { justify-content: space-between; }
.navbar-title { font-size: 1.125rem; font-weight: 750; }
.navbar-menu { gap: var(--space-lg); }
.navbar-tabs, .navbar-actions, .section-actions, .device-actions, .secret-actions, .form-actions { gap: var(--space-sm); }
.tab { min-height: 2.5rem; padding: var(--space-sm) var(--space-md); color: var(--color-text-secondary); background: transparent; border: 0; border-radius: var(--radius-md); cursor: pointer; }
.tab:hover, .tab:focus-visible { color: var(--color-text); background: var(--color-bg-subtle); }
.tab.active { color: var(--color-primary-text); background: var(--color-primary-light); }
.tab:focus-visible { outline: 3px solid var(--color-border-focus); }
.main-content { flex: 1; padding: var(--space-xl) 0; }
.notice-bar { display: flex; align-items: center; gap: var(--space-sm); margin-bottom: var(--space-xl); padding: var(--space-sm) var(--space-md); color: var(--color-info-text); background: var(--color-info-light); border: 1px solid color-mix(in srgb, var(--color-info) 45%, transparent); border-radius: var(--radius-md); font-size: 0.875rem; }
.notice-icon { display: grid; flex: none; place-items: center; width: 1.25rem; height: 1.25rem; border: 1px solid currentColor; border-radius: 50%; font-size: 0.75rem; font-weight: 800; }
.fleet-context { display: flex; align-items: end; gap: var(--space-md); margin-bottom: var(--space-xl); padding: var(--space-md); }
.section-header { gap: var(--space-md); margin-bottom: var(--space-lg); }
.section-subtitle { margin: var(--space-xs) 0 0; color: var(--color-text-secondary); font-size: 0.875rem; }
.refresh-summary { flex-wrap: wrap; gap: var(--space-md); margin: calc(-1 * var(--space-sm)) 0 var(--space-lg); color: var(--color-text-muted); font-size: 0.75rem; }
.dashboard-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--space-lg); }
.status-items { display: grid; gap: var(--space-md); margin-top: var(--space-md); }
.status-item { display: flex; justify-content: space-between; gap: var(--space-md); }
.status-label { color: var(--color-text-secondary); }
.status-indicator { display: inline-flex; align-items: center; gap: var(--space-sm); }
.status-symbol { display: grid; place-items: center; width: 1.25rem; height: 1.25rem; color: white; border-radius: 50%; font-weight: 800; }
.status-symbol-success { background: #047857; }
.status-symbol-danger { background: #b91c1c; }
.stats-items { display: flex; gap: var(--space-xl); margin: var(--space-md) 0; }
.stat-item { text-align: center; }
.stat-value { display: block; color: var(--color-primary-text); font-size: 2rem; font-weight: 700; }
.stat-label, .device-meta { color: var(--color-text-secondary); font-size: 0.75rem; }
.stat-footer { padding-top: var(--space-md); border-top: 1px solid var(--color-border); font-size: 0.875rem; }
.inline-alert { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); margin: var(--space-md) 0 0; padding: var(--space-sm) var(--space-md); border-radius: var(--radius-md); font-size: 0.8125rem; }
.inline-alert-error { color: var(--color-danger-text); background: var(--color-danger-light); border: 1px solid var(--color-danger); }
.inline-alert-warning { color: var(--color-warning-text); background: var(--color-warning-light); border: 1px solid var(--color-warning); }
.messages-heading { align-items: flex-end; }
.filter-panel { display: grid; gap: var(--space-md); margin-bottom: var(--space-md); padding: var(--space-md); }
.filter-row { flex-wrap: wrap; gap: var(--space-md); }
.segmented-control { display: inline-flex; padding: 0.2rem; background: var(--color-bg-subtle); border: 1px solid var(--color-border); border-radius: var(--radius-md); }
.segment { min-height: 2.25rem; padding: 0 var(--space-sm); color: var(--color-text-secondary); background: transparent; border: 0; border-radius: var(--radius-sm); cursor: pointer; }
.segment.active { color: white; background: var(--color-primary); }
.segment-count { margin-left: var(--space-xs); opacity: 0.8; font-variant-numeric: tabular-nums; }
.filter-field, .form-field { display: grid; gap: var(--space-xs); color: var(--color-text-secondary); font-size: 0.75rem; font-weight: 600; }
.filter-select { min-height: 2.5rem; padding: 0 var(--space-sm); color: var(--color-text); background: var(--color-bg-input); border: 1px solid var(--color-border); border-radius: var(--radius-md); }
.group-members-field { min-width: 0; margin: 0; padding: 0; border: 0; }
.group-members-field legend { margin-bottom: var(--space-xs); padding: 0; }
.group-member-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: var(--space-sm); }
.group-member-option { display: flex; align-items: center; gap: var(--space-sm); min-width: 0; padding: var(--space-sm); color: var(--color-text); background: var(--color-bg-subtle); border: 1px solid var(--color-border); border-radius: var(--radius-md); cursor: pointer; }
.group-member-option:has(input:checked) { color: var(--color-primary-text); background: var(--color-primary-light); border-color: var(--color-primary); }
.group-member-option input { flex: none; width: 1rem; height: 1rem; accent-color: var(--color-primary); }
.group-member-option span { display: grid; min-width: 0; gap: 0.1rem; }
.group-member-option strong { overflow-wrap: anywhere; }
.group-member-option small { color: var(--color-text-secondary); font-weight: 500; }
.search-field { flex: 1 1 18rem; }
.reset-filter { align-self: flex-end; }
.partial-alerts { margin-bottom: var(--space-md); }
.messages-list, .device-list { display: grid; gap: var(--space-md); }
.load-more-row { display: flex; justify-content: center; padding: var(--space-lg) 0; }
.device-form, .outbound-form { margin-bottom: var(--space-lg); }
.push-settings-card { display: grid; gap: var(--space-lg); max-width: 52rem; }
.push-settings-form { display: grid; gap: var(--space-lg); padding-top: var(--space-md); border-top: 1px solid var(--color-border); }
.push-toggle, .push-mode-option { display: flex; align-items: flex-start; gap: var(--space-sm); padding: var(--space-md); background: var(--color-bg-subtle); border: 1px solid var(--color-border); border-radius: var(--radius-md); cursor: pointer; }
.push-toggle input, .push-mode-option input { flex: none; width: 1rem; height: 1rem; margin-top: 0.2rem; accent-color: var(--color-primary); }
.push-toggle span, .push-mode-option span { display: grid; gap: var(--space-xs); }
.push-toggle small, .push-mode-option small { color: var(--color-text-secondary); font-weight: 500; }
.push-mode-field { display: grid; gap: var(--space-sm); margin: 0; padding: 0; border: 0; }
.push-mode-field legend { margin-bottom: var(--space-xs); padding: 0; }
.push-mode-option:has(input:checked) { color: var(--color-primary-text); background: var(--color-primary-light); border-color: var(--color-primary); }
.push-mode-danger:has(input:checked) { color: var(--color-danger-text); background: var(--color-danger-light); border-color: var(--color-danger); }
.push-summary { margin: 0; padding-top: var(--space-md); border-top: 1px solid var(--color-border); }
.outbound-warning { margin-bottom: var(--space-md); }
.outbound-body-input { min-height: 7rem; resize: vertical; }
.outbound-history-heading { margin-top: var(--space-xl); }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-md); margin: var(--space-md) 0; }
.form-field-wide { grid-column: 1 / -1; }
.secret-field { gap: var(--space-sm); }
.secret-field .form-input { flex: 1; }
.device-item { display: grid; gap: var(--space-md); }
.device-row { gap: var(--space-md); }
.device-info { display: grid; min-width: 0; gap: 0.2rem; }
.device-info strong { overflow-wrap: anywhere; }
.device-actions { flex-wrap: wrap; justify-content: flex-end; }
.device-edit-form { display: grid; gap: var(--space-md); padding-top: var(--space-md); border-top: 1px solid var(--color-border); }
.pairing-result { display: flex; align-items: center; gap: var(--space-lg); padding-top: var(--space-md); border-top: 1px solid var(--color-border); }
.pairing-qr { width: min(14rem, 60vw); height: auto; background: white; border: 0.5rem solid white; border-radius: var(--radius-md); box-shadow: var(--shadow-md); }
.pairing-instructions { display: grid; gap: var(--space-sm); }
.loading-state, .empty-state { text-align: center; padding: var(--space-2xl); }
.spinner-lg { width: 2rem; height: 2rem; margin: 0 auto var(--space-md); border-width: 3px; }

@media (max-width: 768px) {
  .navbar-content, .navbar-menu, .section-header, .messages-heading, .device-row, .pairing-result { align-items: stretch; flex-direction: column; }
  .navbar-menu { width: 100%; gap: var(--space-sm); }
  .navbar-tabs { width: 100%; }
  .tab { flex: 1; }
  .navbar-actions, .section-actions { justify-content: space-between; }
  .section-actions .btn { flex: 1; }
  .filter-row, .secret-field, .device-actions { align-items: stretch; flex-direction: column; }
  .segmented-control { width: 100%; }
  .segment { flex: 1; }
  .filter-field, .filter-select, .reset-filter { width: 100%; }
  .form-grid { grid-template-columns: 1fr; }
  .form-field-wide { grid-column: auto; }
  .device-actions .btn { width: 100%; }
  .pairing-qr { align-self: center; }
}
</style>
