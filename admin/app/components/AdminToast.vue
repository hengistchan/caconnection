<template>
  <Transition name="toast">
    <div
      v-if="message"
      class="admin-toast"
      :class="`admin-toast-${tone}`"
      role="status"
      aria-live="polite"
    >
      <span>{{ message }}</span>
      <button
        type="button"
        class="toast-close"
        :aria-label="closeLabel"
        @click="$emit('close')"
      >
        ×
      </button>
    </div>
  </Transition>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  message: string
  tone?: 'success' | 'error' | 'info'
  closeLabel: string
}>(), {
  tone: 'info',
})

defineEmits<{ close: [] }>()
</script>

<style scoped>
.admin-toast {
  position: fixed;
  right: var(--space-lg);
  bottom: var(--space-lg);
  z-index: 200;
  display: flex;
  align-items: center;
  gap: var(--space-md);
  max-width: min(28rem, calc(100vw - 2rem));
  padding: var(--space-sm) var(--space-md);
  color: var(--color-text);
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
}

.admin-toast-success {
  border-color: var(--color-success);
}

.admin-toast-error {
  border-color: var(--color-danger);
}

.admin-toast-info {
  border-color: var(--color-info);
}

.toast-close {
  flex: none;
  min-width: 2rem;
  min-height: 2rem;
  color: var(--color-text-secondary);
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 1.25rem;
}

.toast-close:focus-visible {
  outline: 3px solid var(--color-border-focus);
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(0.5rem);
}
</style>
