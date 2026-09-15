<template>
  <div class="language-switcher">
    <button
      class="btn btn-ghost btn-sm"
      :aria-expanded="isOpen"
      aria-haspopup="true"
      :aria-label="t('nav.language')"
      @click="toggleDropdown"
      @keydown.esc="isOpen = false"
    >
      <span class="language-icon">🌐</span>
      <span>{{ currentLocaleName }}</span>
    </button>

    <div
      v-if="isOpen"
      class="language-dropdown"
      role="menu"
    >
      <button
        v-for="localeOption in availableLocales"
        :key="localeOption.code"
        class="language-option"
        :class="{ active: localeOption.code === currentLocale }"
        role="menuitem"
        :aria-current="localeOption.code === currentLocale ? 'true' : undefined"
        @click="switchLocale(localeOption.code)"
      >
        {{ localeOption.name }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
const { t, locale, locales, setLocale } = useI18n()

const isOpen = ref(false)

const currentLocale = computed(() => locale.value)

const availableLocales = computed(() => {
  return (locales.value as Array<{ code: string; name: string }>)
})

const currentLocaleName = computed(() => {
  const current = availableLocales.value.find(l => l.code === currentLocale.value)
  return current?.name || currentLocale.value
})

function toggleDropdown() {
  isOpen.value = !isOpen.value
}

function switchLocale(code: string) {
  setLocale(code)
  isOpen.value = false
}

// Close dropdown when clicking outside
function handleClickOutside(event: MouseEvent) {
  const target = event.target as HTMLElement
  if (!target.closest('.language-switcher')) {
    isOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<style scoped>
.language-switcher {
  position: relative;
}

.language-icon {
  margin-right: 0.25rem;
}

.language-dropdown {
  position: absolute;
  right: 0;
  top: 100%;
  margin-top: 0.25rem;
  background-color: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  min-width: 120px;
  z-index: 100;
}

.language-option {
  display: block;
  width: 100%;
  padding: 0.5rem 1rem;
  text-align: left;
  font-size: 0.875rem;
  color: var(--color-text);
  background: none;
  border: none;
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.language-option:hover {
  background-color: var(--color-bg-subtle);
}

.language-option.active {
  color: var(--color-primary-text);
  font-weight: 500;
}

.language-option:focus-visible {
  outline: 3px solid var(--color-border-focus);
  outline-offset: -3px;
}
</style>
