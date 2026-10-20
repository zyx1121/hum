import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-06T08:00:00Z')
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

function point(agoS: number, value: number, host?: string, extra: Record<string, string> = {}) {
  const attributes = { ...(host ? { 'host.name': host } : { node: 'pve' }), ...extra }
  return { ts: new Date(NOW - agoS * 1000).toISOString(), kind: 'gauge', value, attributes }
}

function nodePoint(agoS: number, value: number, node: string) {
  const attributes = { node }
  return { ts: new Date(NOW - agoS * 1000).toISOString(), kind: 'gauge', value, attributes }
}

// Answers what sensorium's query_metrics would: pve fresh, carrel04 last heard
// from 5 minutes ago, the other carrel nodes and furnace fresh. laptop and macmini still report into
// `devices`, but the band does not list them.
function series(project: string, metric: string) {
  // spawner: nic0 moves 20 KB in 10 s each way; the bridge must not count.
  if (project === 'pve' && metric.startsWith('proxmox_node_network_')) {
    return [
      point(5, 120_000, undefined, { device: 'nic0' }),
      point(5, 9_000_000, undefined, { device: 'vmbr0' }),
      point(15, 100_000, undefined, { device: 'nic0' }),
      point(15, 1_000, undefined, { device: 'vmbr0' }),
    ]
  }
  if (project === 'pve') {
    const v: Record<string, number> = {
      proxmox_node_cpustat_cpu: 0.03,
      proxmox_node_memory_memused: 48,
      proxmox_node_memory_memtotal: 64,
      proxmox_node_blockstat_per: 67,
    }
    return [point(5, v[metric] ?? 0)]
  }
  if (project === 'carrel') {
    if (metric !== 'proxmox_node_cpustat_cpu') return []
    return [nodePoint(4, 0.11, 'carrel01'), nodePoint(5, 0.12, 'carrel02'), nodePoint(6, 0.13, 'carrel03'), nodePoint(300, 0.14, 'carrel04')]
  }
  if (project === 'devices') {
    if (metric === 'hw.gpu.utilization') return [point(3, 0.42, 'furnace')]
    // furnace: receives 1.5 MB and sends 0 in 15 s.
    if (metric === 'system.network.io') {
      return [
        point(3, 3_000_000, 'furnace', { 'network.io.direction': 'receive' }),
        point(3, 500, 'furnace', { 'network.io.direction': 'transmit' }),
        point(18, 1_500_000, 'furnace', { 'network.io.direction': 'receive' }),
        point(18, 500, 'furnace', { 'network.io.direction': 'transmit' }),
      ]
    }
    const v = metric === 'system.filesystem.utilization' ? 0.95 : 0.2
    return [point(3, v, 'furnace'), point(4, v, 'macmini'), point(300, v, 'laptop')]
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
  expect(asked).toContain('carrel/proxmox_node_cpustat_cpu')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'hum', surface, ...BAND })
    const all = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')
    expect(all).toContain('SPAWNER')
    expect(all.indexOf('SPAWNER')).toBeLessThan(all.indexOf('FURNACE'))
    expect(all.indexOf('FURNACE')).toBeLessThan(all.indexOf('CARREL01'))
    expect(all.indexOf('CARREL03')).toBeLessThan(all.indexOf('CARREL04'))
    expect(all).toContain('CPU 11%') // carrel01, picked out of the shared project
    expect(all).toContain('CPU 13%') // carrel03
    expect(all).toContain('MEM 75%') // spawner memory 48/64
    expect(all).toContain('DSK 67%') // spawner disk
    expect(all).toContain('95%') // furnace disk, highlighted
    expect(all).toContain('GPU 42%') // furnace gpu
    expect(all).toContain('4.0K/s') // spawner: 2 + 2 KB/s on nic0 only
    expect(all).toContain('100K/s') // furnace: 100 KB/s
    expect(all.includes('\u{F0EE0}')).toBe(false) // labels, not Nerd Font glyphs
    expect(all.includes('–')).toBe(false) // spawner has no gpu
    expect(all).toContain('5m ago') // carrel04
    expect(all.includes('laptop')).toBe(false)
    expect(all.includes('macmini')).toBe(false)
    await ui.unmount()
  }
})

test('a second session within the refresh window reuses the stored snapshot', async ($, on) => {
  mock.env(on, { SENSORIUM_ZYX_TOKEN: 'sk_test' })
  mock.store(on, { 'snap-v6': { fetchedAt: NOW - 1000, hosts: [{ name: 'furnace', ageS: 1, cpu: 0.1, mem: 0.2, disk: 0.3, gpu: null }], error: null } })
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
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')).toContain('FURNACE')
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
