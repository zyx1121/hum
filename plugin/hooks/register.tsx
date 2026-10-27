import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Host, Snapshot } from '../types'
import { COLOR, lineOf, panelOf, rowOf, type PanelKit, type Seg, type Tone } from './panel'

const MCP = 'https://sensorium.zyx.tw/mcp'
const REFRESH_MS = 15_000
const WINDOW_MS = 90_000
// Bump when Snapshot's shape or the host list changes: sessions still running
// an older build keep writing the old snapshot under the old key.
const STORE_KEY = 'snap-v12'
const ONLINE_S = 60

// PVE nodes report through PVE's own OpenTelemetry metric server, one project
// per cluster, each point tagged with its `node`; the other machines run the
// hum agent into the shared `devices` project. `nodes` maps the PVE node name
// to what the band shows; a `cluster` name folds its nodes into one panel.
const PVE_CLUSTERS: { project: string; nodes: Record<string, string>; cluster?: string }[] = [
  { project: 'pve', nodes: { pve: 'spawner' } },
  { project: 'anvil', nodes: { anvil: 'anvil' } },
  { project: 'enderchest', nodes: { enderchest: 'enderchest' } },
  { project: 'carrel', cluster: 'carrel', nodes: { carrel01: 'carrel01', carrel02: 'carrel02', carrel03: 'carrel03', carrel04: 'carrel04' } },
]
const AGENTS = ['furnace']
// Band order, left to right.
const ORDER = ['spawner', 'furnace', 'enderchest', 'anvil', 'carrel']

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

type NodeReading = Host & { cores: number | null; memUsed: number | null; memTotal: number | null }

async function pveNodes($: EngineInterface, token: string, now: number, project: string, nodes: Record<string, string>): Promise<NodeReading[]> {
  const n = Object.keys(nodes).length
  const [cpu, cores, used, total, disk, rx, tx, temps] = await Promise.all([
    query($, token, project, 'proxmox_node_cpustat_cpu', n * 3),
    query($, token, project, 'proxmox_node_cpustat_cpus', n * 3),
    query($, token, project, 'proxmox_node_memory_memused', n * 3),
    query($, token, project, 'proxmox_node_memory_memtotal', n * 3),
    query($, token, project, 'proxmox_node_blockstat_per', n * 3),
    // A node reports 40 or more interfaces per tick; 3 ticks cover the two newest.
    query($, token, project, 'proxmox_node_network_receive_total', Math.min(1000, n * 200)),
    query($, token, project, 'proxmox_node_network_transmit_total', Math.min(1000, n * 200)),
    // temp-watch, where a node runs it: a few sensors per minute.
    query($, token, project, 'hw.temperature', n * 16),
  ])
  // Points come newest first, so the first one per node is its latest reading.
  const of = (points: Point[], node: string) => points.filter(p => p.attributes.node === node)
  return Object.entries(nodes).map(([node, name]) => {
    const [c, k, u, t, d] = [cpu, cores, used, total, disk].map(points => of(points, node)[0])
    const sensors = new Map<string, Point>()
    for (const p of temps.filter(p => p.attributes['host.name'] === node)) {
      const sensor = String(p.attributes.sensor ?? '')
      if (!sensors.has(sensor)) sensors.set(sensor, p)
    }
    return {
      name,
      ageS: age(now, c),
      cpu: c?.value ?? null,
      mem: u && t?.value ? u.value / t.value : null,
      disk: d ? d.value / 100 : null,
      gpu: null,
      net: sum([nicRate(of(rx, node)), nicRate(of(tx, node))]),
      cores: k?.value ?? null,
      memUsed: u?.value ?? null,
      memTotal: t?.value ?? null,
      temp: hottest([...sensors.values()]),
    }
  })
}

// temp-watch sends each sensor's limit with the point; these cover points sent
// without one. The band warns 5 degrees before a limit.
const TEMP_LIMIT: Record<string, number> = { cpu: 85, nvme: 70, hdd: 50 }

// The hottest sensor in degrees, toned by how close any sensor is to its limit.
function hottest(points: Point[]): Host['temp'] {
  if (!points.length) return null
  let tone: Tone = 'normal'
  for (const p of points) {
    const limit = Number(p.attributes.limit) || TEMP_LIMIT[String(p.attributes.kind)]
    if (limit == null) continue
    if (p.value >= limit) tone = 'error'
    else if (p.value >= limit - 5 && tone === 'normal') tone = 'warn'
  }
  return { c: Math.max(...points.map(p => p.value)), tone }
}

function hostOf({ cores: _c, memUsed: _u, memTotal: _t, ...host }: NodeReading): Host {
  return host
}

// The whole cluster as one machine, over the nodes that are reporting: CPU
// weighted by cores, memory as total used over total, disk as the mean of the
// nodes' root disks, network summed.
function clusterHost(name: string, readings: NodeReading[]): Host {
  const live = readings.filter(r => r.ageS !== null && r.ageS <= ONLINE_S)
  const ages = readings.map(r => r.ageS).filter((a): a is number => a !== null)
  const nodes = { up: live.length, total: readings.length }
  if (!live.length) return { name, ageS: ages.length ? Math.min(...ages) : null, cpu: null, mem: null, disk: null, gpu: null, net: null, nodes }
  const cpus = live.filter(r => r.cpu != null)
  const weight = sum(cpus.map(r => r.cores ?? 1))
  const mems = live.filter(r => r.memUsed != null && r.memTotal)
  const disks = live.map(r => r.disk).filter((d): d is number => d != null)
  return {
    name,
    ageS: Math.min(...live.map(r => r.ageS!)),
    cpu: weight ? sum(cpus.map(r => r.cpu! * (r.cores ?? 1)))! / weight : null,
    mem: mems.length ? sum(mems.map(r => r.memUsed))! / sum(mems.map(r => r.memTotal))! : null,
    disk: disks.length ? sum(disks)! / disks.length : null,
    gpu: null,
    net: sum(live.map(r => r.net)),
    temp: hottestNode(live.map(r => r.temp)),
    nodes,
  }
}

const TONE_RANK: Record<Tone, number> = { dim: 0, normal: 1, warn: 2, error: 3 }

// The hottest node's degrees, toned by the worst node.
function hottestNode(temps: Host['temp'][]): Host['temp'] {
  const known = temps.filter((t): t is NonNullable<Host['temp']> => t != null)
  if (!known.length) return null
  const tone = known.map(t => t.tone).reduce((a, b) => (TONE_RANK[b] > TONE_RANK[a] ? b : a))
  return { c: Math.max(...known.map(t => t.c)), tone }
}

async function pveHosts($: EngineInterface, token: string, now: number, c: (typeof PVE_CLUSTERS)[number]): Promise<Host[]> {
  const readings = await pveNodes($, token, now, c.project, c.nodes)
  return c.cluster ? [clusterHost(c.cluster, readings)] : readings.map(hostOf)
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
      const pve = await Promise.all(PVE_CLUSTERS.map(c => pveHosts($, token, now, c)))
      const hosts = [...pve.flat(), ...(await agentHosts($, token, now))]
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
  const title = host.nodes ? `${host.name.toUpperCase()} ${host.nodes.up}/${host.nodes.total}` : host.name.toUpperCase()
  if (!online) {
    const text = host.ageS === null ? 'no data' : `${Math.round(host.ageS / 60)}m ago`
    return panelOf(kit, { title, tone: 'dim' }, lineOf(kit, [{ text, color: COLOR.muted }]))
  }
  // A metric the host does not report (no GPU) is left out.
  const shown = METRICS.filter(m => host[m.key] != null)
  const segs: Seg[] = shown.flatMap((m, i) => [
    { text: `${i ? '  ' : ''}${m.label} `, color: COLOR.label },
    { text: `${Math.round(host[m.key]! * 100)}`, color: TONE_COLOR[level(host[m.key])], bold: level(host[m.key]) !== 'normal' },
  ])
  if (host.temp) {
    segs.push({ text: `${segs.length ? '  ' : ''}TMP `, color: COLOR.label }, { text: `${Math.round(host.temp.c)}`, color: TONE_COLOR[host.temp.tone], bold: host.temp.tone !== 'normal' })
  }
  const tones = shown.map(m => level(host[m.key]))
  if (host.temp) tones.push(host.temp.tone)
  // A cluster with a node down is at least a warning.
  if (host.nodes && host.nodes.up < host.nodes.total) tones.push('warn')
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
