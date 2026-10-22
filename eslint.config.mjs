// @ts-check
import prettier from 'eslint-config-prettier'
import withNuxt from './.nuxt/eslint.config.mjs'

// Nuxt's generated flat config (Vue + TypeScript rules), with formatting left to Prettier.
export default withNuxt(prettier)
