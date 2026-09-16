<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="dialog-backdrop"
      @click.self="cancel"
    >
      <section
        ref="dialog"
        class="confirm-dialog"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :aria-describedby="descriptionId"
        @keydown="handleKeydown"
      >
        <div class="dialog-icon" :class="{ danger }" aria-hidden="true">!</div>
        <h2 :id="titleId">{{ title }}</h2>
        <p :id="descriptionId">{{ message }}</p>
        <div class="confirm-actions">
          <button
            ref="confirmButton"
            type="button"
            class="btn"
            :class="danger ? 'btn-danger' : 'btn-primary'"
            :disabled="busy"
            @click="$emit('confirm')"
          >
            <span v-if="busy" class="spinner" aria-hidden="true" />
            {{ confirmLabel }}
          </button>
          <button
            type="button"
            class="btn btn-secondary"
            :disabled="busy"
            @click="cancel"
          >
            {{ cancelLabel }}
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
const props = withDefaults(defineProps<{
  open: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  danger?: boolean
  busy?: boolean
}>(), {
  danger: false,
  busy: false,
})

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

const dialog = ref<HTMLElement | null>(null)
const confirmButton = ref<HTMLButtonElement | null>(null)
const titleId = 'admin-confirm-dialog-title'
const descriptionId = 'admin-confirm-dialog-description'
let previousBodyOverflow = ''
let previousActiveElement: HTMLElement | null = null

watch(() => props.open, async (open) => {
  if (open) {
    previousActiveElement = document.activeElement as HTMLElement | null
    previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    await nextTick()
    confirmButton.value?.focus()
  } else {
    document.body.style.overflow = previousBodyOverflow
    await nextTick()
    previousActiveElement?.focus()
    previousActiveElement = null
  }
})

onUnmounted(() => {
  if (props.open) document.body.style.overflow = previousBodyOverflow
})

function cancel(): void {
  if (!props.busy) emit('cancel')
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    cancel()
    return
  }
  if (event.key !== 'Tab' || !dialog.value) return
  const focusable = Array.from(
    dialog.value.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
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
</script>

<style scoped>
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

.dialog-icon.danger {
  color: var(--color-danger-text);
  background: var(--color-danger-light);
}

.confirm-dialog h2 {
  font-size: 1.125rem;
  margin-bottom: var(--space-sm);
}

.confirm-dialog p {
  color: var(--color-text-secondary);
  font-size: 0.875rem;
  margin-bottom: var(--space-lg);
  white-space: pre-wrap;
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm);
}

@media (max-width: 560px) {
  .confirm-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .confirm-actions .btn {
    width: 100%;
  }
}
</style>
