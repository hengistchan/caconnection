<template>
  <article class="call-card card">
    <header class="call-header">
      <div class="call-meta">
        <span class="badge badge-blue">{{ t('calls.badge') }}</span>
        <strong>{{ t(`calls.direction.${call.direction}`) }}</strong>
        <span>{{ formatTime(call.startedAt) }}</span>
        <span v-if="call.slotIndex !== null">
          {{ t('calls.sim', { sim: call.slotIndex + 1 }) }}
        </span>
      </div>
      <span class="call-state" :class="`call-state-${(call.state || 'UNKNOWN').toLowerCase()}`">
        {{ t(`calls.state.${call.state || 'UNKNOWN'}`) }}
      </span>
    </header>

    <dl class="call-fields">
      <div>
        <dt>{{ t('calls.caller') }}</dt>
        <dd>
          <button
            v-if="call.callerAddress"
            class="sensitive-value"
            type="button"
            @click="callerVisible = !callerVisible"
          >
            {{ callerVisible || revealAll ? call.callerAddress : '••••••••' }}
          </button>
          <span v-else>{{ t('calls.unknownCaller') }}</span>
        </dd>
      </div>
      <div v-if="call.callerDisplayName">
        <dt>{{ t('calls.callerName') }}</dt>
        <dd>
          <button
            class="sensitive-value"
            type="button"
            @click="nameVisible = !nameVisible"
          >
            {{ nameVisible || revealAll ? call.callerDisplayName : '••••••••' }}
          </button>
        </dd>
      </div>
      <div>
        <dt>{{ t('calls.result') }}</dt>
        <dd>
          {{ call.answered ? t('calls.answered') : t('calls.notAnswered') }}
          <template v-if="call.durationMillis !== null">
            · {{ formatDuration(call.durationMillis) }}
          </template>
        </dd>
      </div>
    </dl>

    <div class="call-state-history" :aria-label="t('calls.stateHistory')">
      <span
        v-for="entry in call.states"
        :key="`${entry.state}-${entry.observedAt}`"
        class="call-state-chip"
      >
        {{ t(`calls.state.${entry.state}`) }} · {{ formatTime(entry.observedAt) }}
      </span>
    </div>

    <details class="technical-details">
      <summary>{{ t('messages.technicalDetails') }}</summary>
      <dl>
        <div><dt>{{ t('messages.deviceId') }}</dt><dd>{{ call.deviceId }}</dd></div>
        <div><dt>{{ t('calls.sessionId') }}</dt><dd>{{ call.sessionId || '—' }}</dd></div>
        <div><dt>{{ t('calls.resolutionMethod') }}</dt><dd>{{ call.resolutionMethod || '—' }}</dd></div>
        <div><dt>{{ t('calls.confidence') }}</dt><dd>{{ call.resolutionConfidence || '—' }}</dd></div>
      </dl>
    </details>
  </article>
</template>

<script setup lang="ts">
import type { GatewayCall } from '~/composables/useGateway'

const props = withDefaults(defineProps<{
  call: GatewayCall
  revealAll?: boolean
}>(), {
  revealAll: false,
})

const { t, locale } = useI18n()
const callerVisible = ref(false)
const nameVisible = ref(false)

watch(() => props.revealAll, (revealed) => {
  if (!revealed) {
    callerVisible.value = false
    nameVisible.value = false
  }
})

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(timestamp))
}

function formatDuration(durationMillis: number): string {
  const seconds = Math.max(0, Math.round(durationMillis / 1000))
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  return minutes > 0
    ? t('calls.durationMinutesSeconds', { minutes, seconds: remaining })
    : t('calls.durationSeconds', { seconds: remaining })
}
</script>

<style scoped>
.call-card { display: grid; gap: var(--space-md); }
.call-header, .call-meta { display: flex; align-items: center; gap: var(--space-sm); }
.call-header { justify-content: space-between; }
.call-meta { flex-wrap: wrap; color: var(--color-text-secondary); font-size: 0.8rem; }
.call-fields, .technical-details dl { display: grid; gap: var(--space-sm); margin: 0; }
.call-fields > div, .technical-details dl > div { display: grid; grid-template-columns: minmax(7rem, 0.3fr) 1fr; gap: var(--space-md); }
dt { color: var(--color-text-secondary); font-size: 0.75rem; font-weight: 600; }
dd { margin: 0; overflow-wrap: anywhere; }
.sensitive-value { padding: 0.2rem 0.4rem; color: inherit; font: inherit; background: var(--color-bg-subtle); border: 1px solid var(--color-border); border-radius: var(--radius-sm); cursor: pointer; }
.call-state { padding: 0.3rem 0.65rem; font-size: 0.75rem; font-weight: 700; border-radius: 999px; }
.call-state-ringing { color: var(--color-primary-text); background: var(--color-primary-light); }
.call-state-offhook { color: var(--color-success-text); background: var(--color-success-light); }
.call-state-idle, .call-state-unknown { color: var(--color-text-secondary); background: var(--color-bg-subtle); }
.call-state-history { display: flex; flex-wrap: wrap; gap: var(--space-xs); }
.call-state-chip { padding: 0.25rem 0.55rem; color: var(--color-text-secondary); font-size: 0.75rem; background: var(--color-bg-subtle); border-radius: 999px; }
.technical-details summary { cursor: pointer; color: var(--color-text-secondary); font-size: 0.8rem; }
.technical-details dl { margin-top: var(--space-sm); }
@media (max-width: 640px) {
  .call-header { align-items: flex-start; flex-direction: column; }
  .call-fields > div, .technical-details dl > div { grid-template-columns: 1fr; gap: var(--space-xs); }
}
</style>
