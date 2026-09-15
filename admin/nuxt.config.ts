// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-09-14',
  devtools: { enabled: false },

  // Register modules
  modules: ['@nuxtjs/i18n', '@nuxt/eslint', 'nuxt-security'],

  // Run under /admin/ prefix
  app: {
    baseURL: '/admin/',
    head: {
      htmlAttrs: { lang: 'zh-CN' },
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'robots', content: 'noindex, nofollow' },
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/admin/favicon.svg' },
      ],
    },
  },

  // SSR mode
  ssr: true,

  // i18n configuration
  i18n: {
    locales: [
      { code: 'zh-CN', name: '简体中文', file: 'zh-CN.json' },
      { code: 'en', name: 'English', file: 'en.json' },
    ],
    defaultLocale: 'zh-CN',
    lazy: true,
    langDir: '../locales/',
    strategy: 'no_prefix',
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: 'admin_i18n',
      redirectOn: 'root',
    },
  },

  // CSS
  css: ['~/assets/css/main.css'],

  security: {
    strict: false,
    nonce: true,
    sri: true,
    headers: {
      contentSecurityPolicy: {
        'default-src': ['\'none\''],
        'script-src': ['\'self\'', '\'strict-dynamic\'', '\'nonce-{{nonce}}\''],
        'script-src-attr': ['\'none\''],
        'style-src': ['\'self\'', '\'nonce-{{nonce}}\''],
        'img-src': ['\'self\'', 'data:'],
        'font-src': ['\'self\''],
        'connect-src': ['\'self\''],
        'frame-ancestors': ['\'none\''],
        'base-uri': ['\'none\''],
        'form-action': ['\'self\''],
        'object-src': ['\'none\''],
      },
      strictTransportSecurity: {
        maxAge: 31_536_000,
        includeSubdomains: true,
      },
      xContentTypeOptions: 'nosniff',
      xFrameOptions: 'DENY',
      referrerPolicy: 'no-referrer',
      permissionsPolicy: {
        camera: [],
        microphone: [],
        geolocation: [],
      },
    },
    requestSizeLimiter: false,
    rateLimiter: false,
    xssValidator: false,
    corsHandler: false,
    allowedMethodsRestricter: false,
    csrf: false,
    removeLoggers: false,
  },

  routeRules: {
    '/admin/**': {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  },
})
