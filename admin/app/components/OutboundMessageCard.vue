<template>
  <article class="outbound-card card">
    <header class="outbound-header">
      <div class="outbound-meta">
        <span class="badge" :class="statusClass">{{ statusLabel }}</span>
        <span>{{ t('outbound.sim', { sim: message.slotIndex + 1 }) }}</span>
        <time :datetime="createdAtIso">{{ formattedTime }}</time>
      </div>
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        :aria-pressed="revealed"
        @click="revealed = !revealed"
      >
        {{ revealed ? t('messages.hideContent') : t('messages.showContent') }}
      </button>
    </header>

    <dl class="outbound-fields">
      <div>
        <dt>{{ t('outbound.recipient') }}</dt>
        <dd class="sensitive-value" :class="{ revealed }">
          {{ revealed ? message.recipient : maskedRecipient }}
        </dd>
      </div>
      <div>
        <dt>{{ t('outbound.body') }}</dt>
        <dd class="sensitive-value sensitive-value-body" :class="{ revealed }">
          {{ revealed ? message.body : maskedBody }}
        </dd>
      </div>
    </dl>

    <p v-if="message.errorDetail" class="inline-alert inline-alert-error">
      {{ message.errorDetail }}
    </p>

    <details class="technical-details">
      <summary>{{ t('messages.technicalDetails') }}</summary>
      <dl class="outbound-details">
        <div>
          <dt>{{ t('outbound.commandId') }}</dt>
          <dd>{{ message.commandId }}</dd>
        </div>
        <div>
          <dt>{{ t('messages.deviceId') }}</dt>
          <dd>{{ message.deviceId }}</dd>
        </div>
        <div>
          <dt>{{ t('outbound.updatedAt') }}</dt>
          <dd>{{ formattedUpdatedAt }}</dd>
        </div>
        <div v-if="message.lastResultCode !== null">
          <dt>{{ t('outbound.resultCode') }}</dt>
          <dd>{{ message.lastResultCode }}</dd>
        </div>
      </dl>
    </details>
  </article>
</template>

<script setup lang="ts">
import type { GatewayOutboundMessage } from '~/composables/useGateway'

const props = defineProps<{
  message: GatewayOutboundMessage
}>()

const { t, locale } = useI18n()
const revealed = ref(false)
const createdAtIso = computed(() =>
  new Date(props.message.createdAt).toISOString())
const formattedTime = computed(() =>
  new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(props.message.createdAt)))
const formattedUpdatedAt = computed(() =>
  new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(props.message.updatedAt)))
const maskedRecipient = computed(() => {
  const value = props.message.recipient
  if (value.length <= 4) return '••••'
  return `${value.slice(0, 2)}${'•'.repeat(Math.min(8, value.length - 4))}${value.slice(-2)}`
})
const maskedBody = computed(() =>
  props.message.body ? '•'.repeat(Math.min(24, props.message.body.length)) : '—')
const statusClass = computed(() => {
  if (props.message.status === 'DELIVERED') return 'badge-success'
  if (props.message.status === 'FAILED' || props.message.status === 'EXPIRED') {
    return 'badge-danger'
  }
  if (props.message.status === 'SENT_TO_MODEM') return 'badge-info'
  return 'badge-warning'
})
const statusLabel = computed(() =>
  t(`outbound.status.${props.message.status}`))
</script>

<style scoped>
.outbound-card {
  display: grid;
  gap: var(--space-md);
}

.outbound-header,
.outbound-meta {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.outbound-header {
  justify-content: space-between;
}

.outbound-meta {
  flex-wrap: wrap;
  color: var(--color-text-secondary);
  font-size: 0.75rem;
}

.outbound-fields,
.outbound-details {
  display: grid;
  gap: var(--space-sm);
}

.outbound-fields > div,
.outbound-details > div {
  display: grid;
  grid-template-columns: minmax(7rem, 0.25fr) 1fr;
  gap: var(--space-md);
}

.outbound-fields dt,
.outbound-details dt {
  color: var(--color-text-secondary);
  font-size: 0.75rem;
  font-weight: 650;
}

.outbound-fields dd,
.outbound-details dd {
  min-width: 0;
  overflow-wrap: anywhere;
}

.sensitive-value {
  padding: 0.6rem 0.75rem;
  background: var(--color-bg-input);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  filter: blur(5px);
  user-select: none;
}

.sensitive-value.revealed {
  filter: none;
  user-select: text;
}

.sensitive-value-body {
  white-space: pre-wrap;
}

@media (max-width: 640px) {
  .outbound-header {
    align-items: stretch;
    flex-direction: column;
  }

  .outbound-fields > div,
  .outbound-details > div {
    grid-template-columns: 1fr;
    gap: var(--space-xs);
  }
}
</style>
