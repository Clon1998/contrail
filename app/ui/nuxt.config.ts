// Nuxt runs as a pure single-page app inside the Tauri webview: no server-side rendering,
// `nuxt generate` emits static files into `.output/public` which Tauri bundles.
// See https://v2.tauri.app/start/frontend/nuxt/
export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  ssr: false,
  modules: ['@nuxt/eslint', '@nuxt/ui', '@nuxt/test-utils/module'],
  css: ['~/assets/css/main.css'],
  devtools: { enabled: true },
  typescript: { strict: true, typeCheck: false },
  // Listen on the address Tauri provides when developing on a physical device; localhost otherwise.
  devServer: { host: process.env.TAURI_DEV_HOST || 'localhost', port: 3000 },
  vite: {
    // Keep Rust compiler errors visible in the terminal.
    clearScreen: false,
    envPrefix: ['VITE_', 'TAURI_'],
    server: { strictPort: true },
  },
  colorMode: { preference: 'dark' },
  eslint: { config: { stylistic: false } },
})
