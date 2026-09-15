export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === '/login' || to.path === '/admin/login') return

  const { checkSession } = useAuth()
  if (!await checkSession()) {
    return navigateTo('/login', { replace: true })
  }
})
