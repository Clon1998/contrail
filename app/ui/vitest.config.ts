import { defineVitestConfig } from '@nuxt/test-utils/config'

// Tests in tests/nuxt/ run inside a Nuxt environment (auto-imports, components, plugins) on
// happy-dom. Nuxt also type-checks that folder with the app sources.
export default defineVitestConfig({
  test: {
    environment: 'nuxt',
    include: ['tests/nuxt/**/*.{test,spec}.ts'],
  },
})
