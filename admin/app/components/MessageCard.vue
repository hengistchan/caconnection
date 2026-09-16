<template>
  <article class="message-card card">
    <header class="message-header">
      <div class="message-meta">
        <span class="badge" :class="simBadgeClass">{{ simLabel }}</span>
        <time class="message-time" :datetime="receivedAtIso">
          {{ formattedTime }}
        </time>
      </div>
      <button
        v-if="message.sender || message.body"
        type="button"
        class="btn btn-ghost btn-sm"
        @click="toggleCardContent"
      >
        {{ cardContentVisible ? t('messages.hideContent') : t('messages.showContent') }}
      </button>
    </header>

    <dl class="message-fields">
      <div class="message-field">
        <dt>{{ t('messages.sender') }}</dt>
        <dd>
          <button
            v-if="message.sender"
            type="button"
            class="sensitive-value"
            :class="{ revealed: senderVisible }"
            :aria-pressed="senderVisible"
            @click="senderVisible = !senderVisible"
          >
            <span>{{ senderVisible ? message.sender : maskedSender }}</span>
            <span class="sensitive-action">
              {{ senderVisible ? t('messages.hide') : t('messages.show') }}
            </span>
          </button>
          <span v-else>—</span>
        </dd>
      </div>

      <div class="message-field message-field-body">
        <dt>{{ t('messages.body') }}</dt>
        <dd>
          <button
            v-if="message.body"
            type="button"
            class="sensitive-value sensitive-value-body"
            :class="{ revealed: bodyVisible }"
            :aria-pressed="bodyVisible"
            @click="bodyVisible = !bodyVisible"
          >
            <span>{{ bodyVisible ? message.body : maskedBody }}</span>
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
      <dl class="message-details">
        <div class="detail-item">
          <dt>{{ t('messages.eventId') }}</dt>
          <dd>#{{ message.id }}</dd>
        </div>
        <div class="detail-item">
          <dt>{{ t('messages.deviceId') }}</dt>
          <dd>{{ message.deviceId }}</dd>
        </div>
        <div v-if="message.partCount && message.partCount > 1" class="detail-item">
          <dt>{{ t('messages.partCount') }}</dt>
          <dd>{{ message.partCount }}</dd>
        </div>
        <div v-if="message.resolutionMethod" class="detail-item">
          <dt>{{ t('messages.resolutionMethod') }}</dt>
          <dd>{{ message.resolutionMethod }}</dd>
        </div>
        <div v-if="message.resolutionConfidence" class="detail-item">
          <dt>{{ t('messages.resolutionConfidence') }}</dt>
          <dd>{{ confidenceLabel }}</dd>
        </div>
      </dl>
    </details>

    <section v-if="hasOtp" class="message-otp">
      <div class="otp-heading">
        <span class="badge badge-info">
          {{ t('messages.hasOtp') }} · {{ message.otpCandidates.length }}
        </span>
        <button
          v-if="!otpClaimed && !otpCode"
          ref="claimButton"
          type="button"
          class="btn btn-primary btn-sm"
          :disabled="claimingOtp"
          @click="openClaimDialog"
        >
          <span v-if="claimingOtp" class="spinner" aria-hidden="true" />
          {{ claimingOtp ? t('messages.claiming') : t('messages.claimOtp') }}
        </button>
      </div>

      <div v-if="otpCode" class="otp-display" role="status" aria-live="polite">
        <div class="otp-title">{{ t('messages.otpResult.title') }}</div>
        <div class="otp-code">{{ otpCode }}</div>
        <div class="otp-actions">
          <button type="button" class="btn btn-secondary btn-sm" @click="copyOtpCode">
            {{ copiedOtp ? t('messages.otpResult.copied') : t('messages.otpResult.copy') }}
          </button>
          <span class="otp-expiry">
            {{ t('messages.otpResult.autoClose', { seconds: otpCountdown }) }}
          </span>
        </div>
      </div>

      <p v-if="otpError" class="otp-error text-danger" role="alert">
        {{ otpError }}
      </p>
    </section>

    <Teleport to="body">
      <div
        v-if="showClaimConfirm"
        class="dialog-backdrop"
        @click.self="closeClaimDialog"
      >
        <section
          ref="dialog"
          class="confirm-dialog"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="dialogTitleId"
          :aria-describedby="dialogDescriptionId"
          @keydown="handleDialogKeydown"
        >
          <div class="dialog-icon" aria-hidden="true">!</div>
          <h2 :id="dialogTitleId">{{ t('messages.confirmClaim.title') }}</h2>
          <p :id="dialogDescriptionId">{{ t('messages.confirmClaim.message') }}</p>
          <div class="confirm-actions">
            <button
              ref="confirmButton"
              type="button"
              class="btn btn-primary"
              @click="handleClaimOtp"
            >
              {{ t('messages.confirmClaim.confirm') }}
            </button>
            <button type="button" class="btn btn-secondary" @click="closeClaimDialog">
              {{ t('messages.confirmClaim.cancel') }}
            </button>
          </div>
        </section>
      </div>
    </Teleport>
  </article>
</template>

<script setup lang="ts">
import type { GatewayMessage } from '~/composables/useGateway'

const { t, locale } = useI18n()
const { claimOtp } = useGateway()
const props = withDefaults(defineProps<{
  message: GatewayMessage
  revealAll?: boolean
}>(), {
  revealAll: false,
})

const senderVisible = ref(false)
const bodyVisible = ref(false)
const showClaimConfirm = ref(false)
const claimingOtp = ref(false)
const otpCode = ref<string | null>(null)
const otpExpiry = ref<number | null>(null)
const otpError = ref<string | null>(null)
const otpClaimed = ref(false)
const copiedOtp = ref(false)
const otpCountdown = ref(30)
const claimButton = ref<HTMLButtonElement | null>(null)
const confirmButton = ref<HTMLButtonElement | null>(null)
const dialog = ref<HTMLElement | null>(null)
const dialogTitleId = `claim-title-${props.message.id}`
const dialogDescriptionId = `claim-description-${props.message.id}`
let countdownTimer: ReturnType<typeof setInterval> | null = null
let previousBodyOverflow = ''

const simLabel = computed(() => {
  if (props.message.slotIndex === 0) return 'SIM1'
  if (props.message.slotIndex === 1) return 'SIM2'
  return t('messages.unknownSim')
})

const simBadgeClass = computed(() => {
  if (props.message.slotIndex === 0) return 'badge-info'
  if (props.message.slotIndex === 1) return 'badge-success'
  return 'badge-warning'
})

const formattedTime = computed(() =>
  new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(props.message.receivedAt)),
)

const receivedAtIso = computed(() =>
  new Date(props.message.receivedAt).toISOString(),
)

const maskedSender = computed(() => {
  const sender = props.message.sender || ''
  if (sender.length <= 4) return '••••'
  return `${sender.slice(0, 2)}${'•'.repeat(sender.length - 4)}${sender.slice(-2)}`
})

const maskedBody = computed(() => props.message.body ? '••••••••' : '—')
const hasOtp = computed(() => props.message.otpCandidates.length > 0)
const cardContentVisible = computed(() =>
  (!props.message.sender || senderVisible.value)
  && (!props.message.body || bodyVisible.value),
)

const confidenceLabel = computed(() => {
  const normalized = props.message.resolutionConfidence?.toUpperCase()
  if (normalized === 'HIGH') return t('messages.confidence.high')
  if (normalized === 'MEDIUM') return t('messages.confidence.medium')
  if (normalized === 'LOW') return t('messages.confidence.low')
  return props.message.resolutionConfidence || t('dashboard.unknown')
})

watch(otpCode, (newCode) => {
  if (!newCode || !otpExpiry.value) return
  if (countdownTimer) clearInterval(countdownTimer)
  otpCountdown.value = 30
  countdownTimer = setInterval(() => {
    otpCountdown.value -= 1
    if (otpCountdown.value <= 0) clearOtpDisplay()
  }, 1000)
})

watch(showClaimConfirm, async (isOpen) => {
  if (isOpen) {
    previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    await nextTick()
    confirmButton.value?.focus()
  } else {
    document.body.style.overflow = previousBodyOverflow
  }
})

watch(() => props.revealAll, (reveal) => {
  senderVisible.value = reveal
  bodyVisible.value = reveal
}, { immediate: true })

function toggleCardContent(): void {
  const reveal = !cardContentVisible.value
  senderVisible.value = reveal
  bodyVisible.value = reveal
}

function openClaimDialog() {
  showClaimConfirm.value = true
}

function closeClaimDialog() {
  showClaimConfirm.value = false
  nextTick(() => claimButton.value?.focus())
}

function handleDialogKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeClaimDialog()
    return
  }
  if (event.key !== 'Tab' || !dialog.value) return
  const focusable = Array.from(
    dialog.value.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
  )
  if (focusable.length === 0) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function clearOtpDisplay() {
  otpCode.value = null
  otpExpiry.value = null
  if (countdownTimer) clearInterval(countdownTimer)
  countdownTimer = null
}

async function handleClaimOtp() {
  showClaimConfirm.value = false
  claimingOtp.value = true
  otpError.value = null
  try {
    const result = await claimOtp({
      eventId: props.message.id,
      ...(props.message.slotIndex !== null
        ? { slotIndex: props.message.slotIndex }
        : {}),
    })
    if (result?.otp) {
      otpCode.value = result.otp.code
      otpExpiry.value = result.otp.expiresAt
      otpClaimed.value = true
    }
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode
    if (statusCode === 404 || statusCode === 410) {
      otpError.value = t('messages.otpErrors.unavailable')
    } else if (statusCode === 429) {
      otpError.value = t('messages.otpErrors.rateLimited')
    } else {
      otpError.value = t('messages.otpErrors.generic')
    }
  } finally {
    claimingOtp.value = false
  }
}

async function copyOtpCode() {
  if (!otpCode.value) return
  try {
    await navigator.clipboard.writeText(otpCode.value)
    copiedOtp.value = true
    setTimeout(() => { copiedOtp.value = false }, 2000)
  } catch {
    otpError.value = t('messages.otpErrors.copyFailed')
  }
}

onUnmounted(() => {
  if (countdownTimer) clearInterval(countdownTimer)
  if (showClaimConfirm.value) document.body.style.overflow = previousBodyOverflow
})
</script>

<style scoped>
.message-card {
  overflow: hidden;
}

.message-header,
.message-meta,
.otp-heading,
.otp-actions,
.confirm-actions {
  display: flex;
  align-items: center;
}

.message-header {
  justify-content: space-between;
  gap: var(--space-md);
  margin-bottom: var(--space-md);
}

.message-meta,
.otp-actions {
  gap: var(--space-sm);
}

.message-time {
  font-size: 0.75rem;
}

.message-time {
  color: var(--color-text-secondary);
}

.message-fields {
  display: grid;
  gap: var(--space-sm);
}

.message-field {
  display: grid;
  grid-template-columns: minmax(5.5rem, auto) 1fr;
  align-items: start;
  gap: var(--space-sm);
}

.message-field dt,
.detail-item dt {
  color: var(--color-text-secondary);
  font-size: 0.75rem;
  font-weight: 600;
}

.message-field dd,
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

.message-details {
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

.message-otp {
  margin-top: var(--space-md);
  padding-top: var(--space-md);
  border-top: 1px solid var(--color-border);
}

.otp-heading {
  justify-content: space-between;
  gap: var(--space-md);
}

.otp-display {
  margin-top: var(--space-md);
}

.otp-title {
  font-size: 0.875rem;
  font-weight: 700;
  margin-bottom: var(--space-sm);
}

.otp-code {
  margin-bottom: var(--space-md);
}

.otp-actions {
  justify-content: center;
  flex-wrap: wrap;
}

.otp-expiry,
.otp-error {
  font-size: 0.8125rem;
}

.otp-error {
  margin: var(--space-sm) 0 0;
}

.dialog-icon {
  display: grid;
  place-items: center;
  width: 2.5rem;
  height: 2.5rem;
  margin: 0 auto var(--space-md);
  color: var(--color-warning-text);
  background: var(--color-warning-light);
  border-radius: var(--radius-full);
  font-weight: 800;
}

.confirm-dialog h2 {
  font-size: 1.125rem;
  margin-bottom: var(--space-sm);
}

.confirm-dialog p {
  color: var(--color-text-secondary);
  font-size: 0.875rem;
  margin-bottom: var(--space-lg);
}

.confirm-actions {
  justify-content: flex-end;
  gap: var(--space-sm);
}

@media (max-width: 560px) {
  .message-field {
    grid-template-columns: 1fr;
    gap: var(--space-xs);
  }

  .otp-heading,
  .confirm-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .confirm-actions .btn {
    width: 100%;
  }
}
</style>
