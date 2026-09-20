<template>
  <div class="login-page">
    <div class="login-container">
      <div class="login-card card">
        <div class="login-header">
          <div class="login-mark" aria-hidden="true">
            <span>CA</span>
          </div>
          <h1 class="login-title">{{ t('app.name') }}</h1>
          <p class="login-subtitle">
            {{ t(step === 'password' ? 'login.subtitle' : 'login.totpSubtitle') }}
          </p>
        </div>

        <form class="login-form" novalidate @submit.prevent="handleSubmit">
          <div v-if="step === 'password'" class="form-group">
            <label for="password" class="form-label">
              {{ t('login.password') }}
            </label>
            <div class="password-field">
              <input
                id="password"
                v-model="password"
                :type="passwordVisible ? 'text' : 'password'"
                class="form-input"
                :placeholder="t('login.passwordPlaceholder')"
                :disabled="isLoading"
                autocomplete="current-password"
                required
                autofocus
              >
              <button
                type="button"
                class="password-toggle"
                :aria-label="passwordVisible ? t('login.hidePassword') : t('login.showPassword')"
                :aria-pressed="passwordVisible"
                :disabled="isLoading"
                @click="passwordVisible = !passwordVisible"
              >
                {{ passwordVisible ? t('login.hide') : t('login.show') }}
              </button>
            </div>
          </div>

          <div v-else class="form-group">
            <label for="totp-code" class="form-label">
              {{ t('login.totpCode') }}
            </label>
            <input
              id="totp-code"
              v-model="code"
              class="form-input"
              :placeholder="t('login.totpPlaceholder')"
              :disabled="isLoading"
              autocomplete="one-time-code"
              autocapitalize="characters"
              spellcheck="false"
              maxlength="64"
              required
            >
            <p class="totp-hint">
              {{ t('login.totpHint') }}
            </p>
          </div>

          <div v-if="errorMessage" class="login-error" role="alert">
            {{ errorMessage }}
          </div>

          <button
            type="submit"
            class="btn btn-primary btn-lg w-full"
            :disabled="isLoading || !canSubmit"
          >
            <span v-if="isLoading" class="spinner" aria-hidden="true" />
            {{
              isLoading
                ? t('login.submitting')
                : t(step === 'password' ? 'login.submit' : 'login.verifyTotp')
            }}
          </button>
          <button
            v-if="step === 'totp'"
            type="button"
            class="btn w-full secondary-action"
            :disabled="isLoading"
            @click="resetToPassword"
          >
            {{ t('login.backToPassword') }}
          </button>
        </form>

        <div class="login-footer">
          <p class="security-notice">
            {{ t('login.securityNotice') }}
          </p>

          <div class="login-actions">
            <LanguageSwitcher />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const { t } = useI18n()
const { login, verifyTotp, isLoading, checkSession } = useAuth()

const password = ref('')
const code = ref('')
const challenge = ref('')
const step = ref<'password' | 'totp'>('password')
const passwordVisible = ref(false)
const errorMessage = ref<string | null>(null)
const canSubmit = computed(() => (
  step.value === 'password' ? password.value.length > 0 : code.value.trim().length > 0
))

// Redirect if already authenticated
onMounted(async () => {
  const authenticated = await checkSession()
  if (authenticated) {
    await navigateTo('/', { replace: true })
  }
})

async function handleSubmit() {
  if (!canSubmit.value || isLoading.value) return

  errorMessage.value = null

  if (step.value === 'password') {
    const result = await login(password.value)

    if (result.success) {
      await navigateTo('/')
      return
    }
    if (result.requiresTotp && result.challenge) {
      challenge.value = result.challenge
      password.value = ''
      passwordVisible.value = false
      step.value = 'totp'
      await nextTick()
      document.getElementById('totp-code')?.focus()
      return
    }
    errorMessage.value = result.error === 'rateLimit'
      ? t('login.rateLimit')
      : t('login.error')
    password.value = ''
    passwordVisible.value = false
    return
  }

  const result = await verifyTotp(challenge.value, code.value)
  if (result.success) {
    await navigateTo('/')
    return
  }
  errorMessage.value = result.error === 'rateLimit'
    ? t('login.rateLimit')
    : t('login.totpError')
  code.value = ''
}

function resetToPassword() {
  step.value = 'password'
  challenge.value = ''
  code.value = ''
  errorMessage.value = null
  nextTick(() => {
    document.getElementById('password')?.focus()
  })
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-lg);
  background-color: var(--color-bg);
}

.login-container {
  width: 100%;
  max-width: 400px;
}

.login-card {
  padding: var(--space-xl);
  box-shadow: var(--shadow-lg);
}

.login-header {
  text-align: center;
  margin-bottom: var(--space-xl);
}

.login-mark {
  display: grid;
  place-items: center;
  width: 3.25rem;
  height: 3.25rem;
  margin: 0 auto var(--space-md);
  color: white;
  background: linear-gradient(145deg, var(--color-primary), var(--color-primary-hover));
  border-radius: 1rem;
  box-shadow: var(--shadow-md);
  font-size: 0.9rem;
  font-weight: 800;
  letter-spacing: 0.04em;
}

.login-title {
  font-size: 1.5rem;
  margin-bottom: var(--space-sm);
}

.login-subtitle {
  color: var(--color-text-secondary);
  font-size: 0.875rem;
  margin-bottom: 0;
}

.login-form {
  margin-bottom: var(--space-xl);
}

.password-field {
  position: relative;
}

.password-field .form-input {
  padding-right: 4.5rem;
}

.password-toggle {
  position: absolute;
  top: 50%;
  right: var(--space-sm);
  padding: 0.25rem 0.4rem;
  color: var(--color-primary-text);
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  transform: translateY(-50%);
  cursor: pointer;
  font-size: 0.75rem;
  font-weight: 700;
}

.password-toggle:focus-visible {
  outline: 3px solid var(--color-border-focus);
  outline-offset: 1px;
}

.totp-hint {
  margin: var(--space-sm) 0 0;
  color: var(--color-text-muted);
  font-size: 0.75rem;
  line-height: 1.5;
}

.secondary-action {
  margin-top: var(--space-sm);
}

.login-error {
  background-color: var(--color-danger-light);
  color: var(--color-danger-text);
  border: 1px solid color-mix(in srgb, var(--color-danger) 45%, transparent);
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-md);
  font-size: 0.875rem;
  margin-bottom: var(--space-md);
}

.login-footer {
  text-align: center;
}

.security-notice {
  font-size: 0.75rem;
  color: var(--color-text-muted);
  margin-bottom: var(--space-md);
  line-height: 1.5;
}

.login-actions {
  display: flex;
  justify-content: center;
}
</style>
