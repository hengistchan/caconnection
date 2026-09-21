interface SessionResponse {
  authenticated: boolean
  csrfToken: string | null
}

interface LoginResponse {
  success: boolean
  csrfToken?: string
  requiresTotp?: boolean
  challenge?: string
}

export function useAuth() {
  const isAuthenticated = useState<boolean>('auth-status', () => false)
  const isLoading = useState<boolean>('auth-loading', () => false)
  const csrfToken = useState<string | null>('auth-csrf-token', () => null)
  const requestFetch = import.meta.server ? useRequestFetch() : $fetch

  async function checkSession(): Promise<boolean> {
    try {
      const response = await requestFetch<SessionResponse>(
        '/admin/api/auth/session',
        {
          method: 'GET',
          credentials: 'include',
        },
      )
      isAuthenticated.value = response.authenticated
      csrfToken.value = response.authenticated ? response.csrfToken : null
      return response.authenticated
    } catch {
      isAuthenticated.value = false
      csrfToken.value = null
      return false
    }
  }

  async function login(
    password: string,
  ): Promise<{ success: boolean; requiresTotp?: boolean; challenge?: string; error?: string }> {
    isLoading.value = true
    try {
      const response = await $fetch<LoginResponse>('/admin/api/auth/login', {
        method: 'POST',
        body: { password },
        credentials: 'include',
      })
      if (response.requiresTotp && response.challenge) {
        return { success: false, requiresTotp: true, challenge: response.challenge }
      }
      if (!response.success || !response.csrfToken) {
        return { success: false, error: 'invalid' }
      }
      isAuthenticated.value = true
      csrfToken.value = response.csrfToken
      return { success: true }
    } catch (error: unknown) {
      const err = error as { statusCode?: number }
      return {
        success: false,
        error: err.statusCode === 429 ? 'rateLimit' : 'invalid',
      }
    } finally {
      isLoading.value = false
    }
  }

  async function verifyTotp(
    challenge: string,
    code: string,
  ): Promise<{ success: boolean; error?: string }> {
    isLoading.value = true
    try {
      const response = await $fetch<LoginResponse>('/admin/api/auth/login', {
        method: 'POST',
        body: { challenge, code },
        credentials: 'include',
      })
      if (!response.success || !response.csrfToken) return { success: false, error: 'invalid' }
      isAuthenticated.value = true
      csrfToken.value = response.csrfToken
      return { success: true }
    } catch (error: unknown) {
      const err = error as { statusCode?: number }
      return { success: false, error: err.statusCode === 429 ? 'rateLimit' : 'invalid' }
    } finally {
      isLoading.value = false
    }
  }

  async function logout(): Promise<void> {
    try {
      if (csrfToken.value) {
        await $fetch('/admin/api/auth/logout', {
          method: 'POST',
          credentials: 'include',
          headers: { 'X-CSRF-Token': csrfToken.value },
        })
      }
    } catch {
      // Local state is still cleared so an expired session cannot trap the user.
    } finally {
      isAuthenticated.value = false
      csrfToken.value = null
      await navigateTo('/login')
    }
  }

  return {
    isAuthenticated: readonly(isAuthenticated),
    isLoading: readonly(isLoading),
    csrfToken: readonly(csrfToken),
    checkSession,
    login,
    verifyTotp,
    logout,
  }
}
