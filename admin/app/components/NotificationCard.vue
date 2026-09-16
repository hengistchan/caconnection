<template>
  <article class="notification-card card">
    <header class="notification-header">
      <div class="notification-meta">
        <span class="badge badge-purple">{{ t('messages.notification') }}</span>
        <span class="source-package">{{ notification.sourcePackage || '—' }}</span>
        <time class="notification-time" :datetime="receivedAtIso">
          {{ formattedTime }}
        </time>
      </div>
      <button
        v-if="notification.title || notification.body"
        type="button"
        class="btn btn-ghost btn-sm"
        @click="toggleCardContent"
      >
        {{ cardContentVisible ? t('messages.hideContent') : t('messages.showContent') }}
      </button>
    </header>

    <dl class="notification-fields">
      <div class="notification-field">
        <dt>{{ t('messages.notificationTitle') }}</dt>
        <dd>
          <button
            v-if="notification.title"
            type="button"
            class="sensitive-value"
            :class="{ revealed: titleVisible }"
            :aria-pressed="titleVisible"
            @click="titleVisible = !titleVisible"
          >
            <span>{{ titleVisible ? notification.title : maskedTitle }}</span>
            <span class="sensitive-action">
              {{ titleVisible ? t('messages.hide') : t('messages.show') }}
            </span>
          </button>
          <span v-else>—</span>
        </dd>
      </div>

      <div class="notification-field">
        <dt>{{ t('messages.notificationBody') }}</dt>
        <dd>
          <button
            v-if="notification.body"
            type="button"
            class="sensitive-value sensitive-value-body"
            :class="{ revealed: bodyVisible }"
            :aria-pressed="bodyVisible"
            @click="bodyVisible = !bodyVisible"
          >
            <span>{{ bodyVisible ? notification.body : maskedBody }}</span>
            <span class="sensitive-action">
              {{ bodyVisible ? t('messages.hide') : t('messages.show') }}
            </span>
          </button>
          <span v-else>—</span>
        </dd>
      </div>
    </dl>

    <details class="technical-details">
      <summary>{{ t('messages.technicalDetails') }}</summary>
      <dl class="notification-details">
        <div class="detail-item">
          <dt>{{ t('messages.eventId') }}</dt>
          <dd>#{{ notification.id }}</dd>
        </div>
        <div class="detail-item">
          <dt>{{ t('messages.deviceId') }}</dt>
          <dd>{{ notification.deviceId }}</dd>
        </div>
        <div v-if="notification.channelId" class="detail-item">
          <dt>{{ t('messages.notificationChannel') }}</dt>
          <dd>{{ notification.channelId }}</dd>
        </div>
        <div v-if="notification.category" class="detail-item">
          <dt>{{ t('messages.notificationCategory') }}</dt>
          <dd>{{ notification.category }}</dd>
        </div>
      </dl>
    </details>
  </article>
</template>

<script setup lang="ts">
import type { GatewayNotification } from '~/composables/useGateway'

const { t, locale } = useI18n()
const props = withDefaults(defineProps<{
  notification: GatewayNotification
  revealAll?: boolean
}>(), {
  revealAll: false,
})

const titleVisible = ref(false)
const bodyVisible = ref(false)

const formattedTime = computed(() =>
  new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(props.notification.receivedAt)),
)

const receivedAtIso = computed(() =>
  new Date(props.notification.receivedAt).toISOString(),
)

const maskedTitle = computed(() => props.notification.title ? '••••••••' : '—')
const maskedBody = computed(() => props.notification.body ? '••••••••' : '—')
const cardContentVisible = computed(() =>
  (!props.notification.title || titleVisible.value)
  && (!props.notification.body || bodyVisible.value),
)

watch(() => props.revealAll, (reveal) => {
  titleVisible.value = reveal
  bodyVisible.value = reveal
}, { immediate: true })

function toggleCardContent(): void {
  const reveal = !cardContentVisible.value
  titleVisible.value = reveal
  bodyVisible.value = reveal
}
</script>

<style scoped>
.notification-card {
  overflow: hidden;
}

.notification-header,
.notification-meta {
  display: flex;
  align-items: center;
}

.notification-header {
  justify-content: space-between;
  gap: var(--space-md);
  margin-bottom: var(--space-md);
}

.notification-meta {
  flex-wrap: wrap;
  gap: var(--space-sm);
}

.source-package {
  font-family: var(--font-mono);
  font-size: 0.75rem;
}

.notification-time {
  color: var(--color-text-secondary);
  font-size: 0.75rem;
}

.notification-fields {
  display: grid;
  gap: var(--space-sm);
}

.notification-field {
  display: grid;
  grid-template-columns: minmax(7rem, auto) 1fr;
  align-items: start;
  gap: var(--space-sm);
}

.notification-field dt,
.detail-item dt {
  color: var(--color-text-secondary);
  font-size: 0.75rem;
  font-weight: 600;
}

.notification-field dd,
.detail-item dd {
  min-width: 0;
  margin: 0;
}

.sensitive-value {
  width: 100%;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-md);
  color: var(--color-text);
  background: var(--color-sensitive-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 0.45rem 0.65rem;
  text-align: left;
  cursor: pointer;
}

.sensitive-value:not(.revealed) > span:first-child {
  filter: blur(5px);
  user-select: none;
}

.sensitive-value-body {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.sensitive-action {
  flex: none;
  color: var(--color-primary-text);
  font-size: 0.75rem;
  font-weight: 700;
}

.notification-details {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-lg);
  margin-top: var(--space-sm);
}

.detail-item {
  display: grid;
  gap: 0.1rem;
}

.technical-details {
  margin-top: var(--space-md);
  padding-top: var(--space-md);
  border-top: 1px solid var(--color-border);
}

.technical-details summary {
  color: var(--color-primary-text);
  cursor: pointer;
  font-size: 0.8125rem;
  font-weight: 650;
}

.badge-purple {
  color: var(--color-purple-text, #6d28d9);
  background: var(--color-purple-light, #ede9fe);
}

@media (max-width: 560px) {
  .notification-field {
    grid-template-columns: 1fr;
    gap: var(--space-xs);
  }
}
</style>
