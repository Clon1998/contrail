import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import IndexPage from '~/pages/index.vue'

describe('index page', () => {
  afterEach(() => clearMocks())

  it('shows the app name', async () => {
    const page = await mountSuspended(IndexPage)
    expect(page.get('h1').text()).toBe('Contrail')
  })

  it('greets via the Rust greet command', async () => {
    const calls: Array<{ cmd: string; args: unknown }> = []
    mockIPC((cmd, args) => {
      calls.push({ cmd, args })
      return 'Hello, Patrick! Greetings from Contrail.'
    })

    const page = await mountSuspended(IndexPage)
    await page.get('input').setValue('Patrick')
    await page.get('form').trigger('submit')
    await flushPromises()

    expect(calls).toEqual([{ cmd: 'greet', args: { name: 'Patrick' } }])
    expect(page.get('[data-testid="greeting"]').text()).toBe(
      'Hello, Patrick! Greetings from Contrail.',
    )
  })
})
