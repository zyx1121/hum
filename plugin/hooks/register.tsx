import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Host, Snapshot } from '../types'
import { COLOR, lineOf, panelOf, rowOf, type PanelKit, type Seg, type Tone } from './panel'

const MCP = 'https://sensorium.zyx.tw/mcp'
const REFRESH_MS = 15_000
const WINDOW_MS = 90_000
// Bump when Snapshot's shape or the host list changes: sessions still running
// an older build keep writing the old snapshot under the old key.
const STORE_KEY = 'snap-v5'
const ONLINE_S = 60

// PVE nodes report through PVE's own OpenTelemetry metric server, one project
// per node; the other machines run the hum agent into the shared `devices` project.
// The project is named after the PVE node; `name` is what the band shows.
const PVE_NODES = [
  { project: 'pve', name: 'spawner' },
  { project: 'carrel01', name: 'carrel01' },
]
const AGENTS = ['furnace']
// Band order, left to right.
const ORDER = ['spawner', 'furnace', 'carrel01']

const snap = atom({ plugin: 'hum', key: 'snap' } as const, null)

type Point = { ts: string; value: number; attributes: Record<string, unknown> }
type Series = { points: Point[] }

async function query($: EngineInterface, token: string, project: string, metricName: string, limit: number): Promise<Point[]> {
  const since = new Date((await $.clock.now()) - WINDOW_MS).toISOString()
  const res = await $.http.fetch(MCP, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'query_metrics', arguments: { project, metricName, since, limit } },
    }),
  })
  if (!res.ok) throw new Error(`sensorium ${res.status}`)
  const body = JSON.parse(res.text)
  const text = body?.result?.content?.[0]?.text
  if (body?.result?.isError || typeof text !== 'string') return []
  return (JSON.parse(text) as Series).points ?? []
}

// Rate of a cumulative counter from its two newest readings; a reset counts as 0.
function rate(points: Point[]): number | null {
  const [b, a] = points
  if (!a || !b) return null
  const dt = (Date.parse(b.ts) - Date.parse(a.ts)) / 1000
  return dt > 0 ? Math.max(0, b.value - a.value) / dt : null
}

function sum(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v != null)
  return known.length ? known.reduce((a, b) => a + b, 0) : null
}

// PVE reports every bridge, tap and tunnel too; only the physical NICs count.
const PHYSICAL_NIC = /^(nic|en|eth|wl)/

function nicRate(points: Point[]): number | null {
  const devices = new Map<string, Point[]>()
  for (const p of points) {
    const device = String(p.attributes.device ?? '')
    if (PHYSICAL_NIC.test(device)) devices.set(device, [...(devices.get(device) ?? []), p])
  }
  return sum([...devices.values()].map(rate))
}

function age(now: number, p: Point | undefined): number | null {
  return p ? Math.max(0, Math.round((now - Date.parse(p.ts)) / 1000)) : null
}

async function pveHost($: EngineInterface, token: string, now: number, project: string, name: string): Promise<Host> {
  const [cpu, used, total, disk, rx, tx] = await Promise.all([
    query($, token, project, 'proxmox_node_cpustat_cpu', 1),
    query($, token, project, 'proxmox_node_memory_memused', 1),
    query($, token, project, 'proxmox_node_memory_memtotal', 1),
    query($, token, project, 'proxmox_node_blockstat_per', 1),
    // A node reports about 40 interfaces per tick; 3 ticks cover the two newest.
    query($, token, project, 'proxmox_node_network_receive_total', 150),
    query($, token, project, 'proxmox_node_network_transmit_total', 150),
  ])
  return {
    name,
    ageS: age(now, cpu[0]),
    cpu: cpu[0]?.value ?? null,
    mem: used[0] && total[0]?.value ? used[0].value / total[0].value : null,
    disk: disk[0] ? disk[0].value / 100 : null,
    gpu: null,
    net: sum([nicRate(rx), nicRate(tx)]),
  }
}

async function agentHosts($: EngineInterface, token: string, now: number): Promise<Host[]> {
  const limit = AGENTS.length * 16
  const [cpu, mem, fs, gpu, net] = await Promise.all([
    query($, token, 'devices', 'system.cpu.utilization', limit),
    query($, token, 'devices', 'system.memory.utilization', limit),
    query($, token, 'devices', 'system.filesystem.utilization', limit),
    query($, token, 'devices', 'hw.gpu.utilization', limit),
    query($, token, 'devices', 'system.network.io', 64),
  ])
  // Points come newest first, so the first one per host is its latest reading.
  const latest = (points: Point[], host: string) => points.find(p => p.attributes['host.name'] === host)
  return AGENTS.map(name => {
    const disks = fs.filter(p => p.attributes['host.name'] === name).map(p => p.value)
    return {
      name,
      ageS: age(now, latest(cpu, name)),
      cpu: latest(cpu, name)?.value ?? null,
      mem: latest(mem, name)?.value ?? null,
      disk: disks.length ? Math.max(...disks) : null,
      gpu: latest(gpu, name)?.value ?? null,
      net: sum(
        ['receive', 'transmit'].map(dir =>
          rate(net.filter(p => p.attributes['host.name'] === name && p.attributes['network.io.direction'] === dir)),
        ),
      ),
    }
  })
}

async function refresh($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  // Sessions share one fetch: a snapshot another session stored recently is reused.
  const cached = (await $.store.get(STORE_KEY)) as Snapshot | undefined
  if (cached && now - cached.fetchedAt < REFRESH_MS - 2_000) {
    await update($, snap, () => cached)
    return
  }
  const token = await $.env.get('SENSORIUM_ZYX_TOKEN')
  let next: Snapshot
  if (!token) {
    next = { fetchedAt: now, hosts: [], error: 'SENSORIUM_ZYX_TOKEN is not set' }
  } else {
    try {
      const pve = await Promise.all(PVE_NODES.map(n => pveHost($, token, now, n.project, n.name)))
      const hosts = [...pve, ...(await agentHosts($, token, now))]
      hosts.sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name))
      next = { fetchedAt: now, hosts, error: null }
    } catch (err) {
      next = { fetchedAt: now, hosts: cached?.hosts ?? [], error: String((err as Error).message ?? err) }
    }
  }
  await $.store.set(STORE_KEY, next)
  await update($, snap, () => next)
}

const METRICS = [
  { key: 'cpu', label: 'CPU' },
  { key: 'mem', label: 'MEM' },
  { key: 'disk', label: 'DSK' },
  { key: 'gpu', label: 'GPU' },
] as const

// Bytes per second, short: 512B, 4.3K, 12M.
function bytes(v: number): string {
  const units = ['B', 'K', 'M', 'G']
  let i = 0
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i += 1
  }
  return `${v < 10 && i ? v.toFixed(1) : Math.round(v)}${units[i]}`
}

function level(v: number | null | undefined): Tone {
  if (v == null) return 'normal'
  if (v >= 0.9) return 'error'
  if (v >= 0.75) return 'warn'
  return 'normal'
}

const TONE_COLOR: Record<Tone, string> = { normal: COLOR.text, warn: COLOR.warn, error: COLOR.error, dim: COLOR.muted }

// One panel per host: its metrics inside, its network rate on the bottom edge,
// the border colored by its worst metric.
function hostPanel(kit: PanelKit, host: Host): RenderElement {
  const online = host.ageS !== null && host.ageS <= ONLINE_S
  const title = host.name.toUpperCase()
  if (!online) {
    const text = host.ageS === null ? 'no data' : `${Math.round(host.ageS / 60)}m ago`
    return panelOf(kit, { title, tone: 'dim' }, lineOf(kit, [{ text, color: COLOR.muted }]))
  }
  // A metric the host does not report (no GPU) is left out.
  const shown = METRICS.filter(m => host[m.key] != null)
  const segs: Seg[] = shown.flatMap((m, i) => [
    { text: `${i ? '  ' : ''}${m.label} `, color: COLOR.label },
    { text: `${Math.round(host[m.key]! * 100)}%`, color: TONE_COLOR[level(host[m.key])], bold: level(host[m.key]) !== 'normal' },
  ])
  const tones = shown.map(m => level(host[m.key]))
  const tone: Tone = tones.includes('error') ? 'error' : tones.includes('warn') ? 'warn' : 'normal'
  return panelOf(kit, { title, tone, subtitle: host.net != null ? `${bytes(host.net)}/s` : undefined }, lineOf(kit, segs))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    void refresh($)
    $.clock.every(REFRESH_MS, () => refresh($))
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snap)
    if (e.props.hasSurvey || !s) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const mine = s.hosts.map(host => hostPanel({ Box, Text }, host))
    if (s.error) {
      mine.push(panelOf({ Box, Text }, { title: 'SENSORIUM', tone: 'error' }, lineOf({ Box, Text }, [{ text: s.error, color: COLOR.error }])))
    }
    return rowOf({ Box, Text }, mine, await next(e), true)
  })
}
