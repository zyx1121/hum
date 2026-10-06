import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-06T08:00:00Z')
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

function point(agoS: number, value: number, host?: string) {
  return { ts: new Date(NOW - agoS * 1000).toISOString(), kind: 'gauge', value, attributes: host ? { 'host.name': host } : { node: 'pve' } }
}

// Answers what sensorium's query_metrics would: pve fresh, carrel01 unknown,
// king and macmini fresh, laptop last heard from 5 minutes ago.
function series(project: string, metric: string) {
  if (project === 'pve') {
    const v: Record<string, number> = {
      proxmox_node_cpustat_cpu: 0.03,
      proxmox_node_memory_memused: 48,
      proxmox_node_memory_memtotal: 64,
      proxmox_node_blockstat_per: 67,
    }
    return [point(5, v[metric] ?? 0)]
  }
  if (project === 'devices') {
    if (metric === 'hw.gpu.utilization') return [point(3, 0.42, 'king')]
    const v = metric === 'system.filesystem.utilization' ? 0.95 : 0.2
    return [point(3, v, 'king'), point(4, v, 'macmini'), point(300, v, 'laptop')]
  }
  return []
}

test('the band shows each machine, its load and who is offline', async ($, on) => {
  mock.env(on, { SENSORIUM_ZYX_TOKEN: 'sk_test' })
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  const asked: string[] = []
  on('http.fetch', async (_$, e) => {
    const args = JSON.parse(e.init?.body ?? '{}').params.arguments
    asked.push(`${args.project}/${args.metricName}`)
    expect(e.init?.headers?.authorization).toBe('Bearer sk_test')
    const text = JSON.stringify({ points: series(args.project, args.metricName) })
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ result: { content: [{ type: 'text', text }] } }) } }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($t, e) => { const { Text } = $t.ui.resolve(e); return <Text>base</Text> })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(asked).toContain('carrel01/proxmox_node_cpustat_cpu')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'hum', surface, ...BAND })
    const all = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')
    expect(all).toContain('pve')
    expect(all).toContain('75%') // pve memory 48/64
    expect(all).toContain('67%') // pve disk
    expect(all).toContain('95%') // king disk, highlighted
    expect(all).toContain('42%') // king gpu
    expect(all).toContain('5m ago') // laptop
    expect(all).toContain('no data') // carrel01
    await ui.unmount()
  }
})

test('a second session within the refresh window reuses the stored snapshot', async ($, on) => {
  mock.env(on, { SENSORIUM_ZYX_TOKEN: 'sk_test' })
  mock.store(on, { 'snap-v2': { fetchedAt: NOW - 1000, hosts: [{ name: 'king', ageS: 1, cpu: 0.1, mem: 0.2, disk: 0.3, gpu: null }], error: null } })
  const clock = mock.clock(on, { now: NOW })
  let fetches = 0
  on('http.fetch', async () => {
    fetches += 1
    return { value: { status: 500, ok: false, headers: {}, text: '' } }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($t, e) => { const { Text } = $t.ui.resolve(e); return <Text>base</Text> })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(fetches).toBe(0)
  const ui = await $.ui.mount({ plugin: 'hum', surface: 'terminal', ...BAND })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')).toContain('king')
})

test('without a token the band says so instead of fetching', async ($, on) => {
  mock.env(on, {})
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  on('ui.render', { component: 'AbovePrompt' }, ($t, e) => { const { Text } = $t.ui.resolve(e); return <Text>base</Text> })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'hum', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /SENSORIUM_ZYX_TOKEN/ })).toBeDefined()
})
