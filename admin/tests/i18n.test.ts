import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Load locale files directly
const zhCN = JSON.parse(readFileSync(resolve(__dirname, '../locales/zh-CN.json'), 'utf-8'))
const en = JSON.parse(readFileSync(resolve(__dirname, '../locales/en.json'), 'utf-8'))

describe('i18n Locales', () => {
  describe('Translation key completeness', () => {
    it('zh-CN and en should have the same top-level keys', () => {
      const zhKeys = Object.keys(zhCN).sort()
      const enKeys = Object.keys(en).sort()
      expect(zhKeys).toEqual(enKeys)
    })

    it('zh-CN and en should have the same nested structure', () => {
      function getNestedKeys(obj: Record<string, unknown>, prefix = ''): string[] {
        const keys: string[] = []
        for (const [key, value] of Object.entries(obj)) {
          const fullKey = prefix ? `${prefix}.${key}` : key
          keys.push(fullKey)
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            keys.push(...getNestedKeys(value as Record<string, unknown>, fullKey))
          }
        }
        return keys
      }

      const zhKeys = getNestedKeys(zhCN).sort()
      const enKeys = getNestedKeys(en).sort()

      // Check that all zh-CN keys exist in en
      for (const key of zhKeys) {
        expect(enKeys).toContain(key)
      }

      // Check that all en keys exist in zh-CN
      for (const key of enKeys) {
        expect(zhKeys).toContain(key)
      }
    })
  })

  describe('Required translation keys', () => {
    const requiredKeys = [
      'app.name',
      'login.title',
      'login.password',
      'login.submit',
      'login.error',
      'nav.dashboard',
      'nav.messages',
      'nav.logout',
      'pairing.title',
      'pairing.generate',
      'dashboard.title',
      'dashboard.gatewayStatus',
      'dashboard.online',
      'dashboard.offline',
      'messages.title',
      'messages.filter.all',
      'messages.filter.sim1',
      'messages.filter.sim2',
      'messages.sender',
      'messages.body',
      'messages.claimOtp',
      'error.unauthorized',
      'error.serverError',
    ]

    for (const key of requiredKeys) {
      it(`should have key: ${key}`, () => {
        const parts = key.split('.')
        let zhValue: unknown = zhCN
        let enValue: unknown = en

        for (const part of parts) {
          expect(zhValue).toBeDefined()
          expect(enValue).toBeDefined()
          zhValue = (zhValue as Record<string, unknown>)[part]
          enValue = (enValue as Record<string, unknown>)[part]
        }

        expect(zhValue).toBeDefined()
        expect(enValue).toBeDefined()
        expect(typeof zhValue).toBe('string')
        expect(typeof enValue).toBe('string')
      })
    }
  })

  describe('No empty translations', () => {
    function checkNoEmptyStrings(obj: Record<string, unknown>, path = ''): void {
      for (const [key, value] of Object.entries(obj)) {
        const fullPath = path ? `${path}.${key}` : key
        if (typeof value === 'string') {
          it(`${fullPath} should not be empty`, () => {
            expect(value.trim()).not.toBe('')
          })
        } else if (value && typeof value === 'object') {
          checkNoEmptyStrings(value as Record<string, unknown>, fullPath)
        }
      }
    }

    describe('zh-CN', () => checkNoEmptyStrings(zhCN))
    describe('en', () => checkNoEmptyStrings(en))
  })
})
