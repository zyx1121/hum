import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Host, Snapshot } from '../types'

const MCP = 'https://sensorium.zyx.tw/mcp'
const REFRESH_MS = 15_000
const WINDOW_MS = 90_000
const ONLINE_S = 60

// PVE nodes report through PVE's own OpenTelemetry metric server, one project
// per node; the other machines run the hum agent into the shared `devices` project.
const PVE_NODES = ['pve', 'carrel01']
const AGENTS = ['king', 'laptop', 'macmini']

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

function age(now: number, p: Point | undefined): number | null {
  return p ? Math.max(0, Math.round((now - Date.parse(p.ts)) / 1000)) : null
}

async function pveHost($: EngineInterface, token: string, now: number, name: string): Promise<Host> {
  const [cpu, used, total, disk] = await Promise.all([
    query($, token, name, 'proxmox_node_cpustat_cpu', 1),
    query($, token, name, 'proxmox_node_memory_memused', 1),
    query($, token, name, 'proxmox_node_memory_memtotal', 1),
    query($, token, name, 'proxmox_node_blockstat_per', 1),
  ])
  return {
    name,
    ageS: age(now, cpu[0]),
    cpu: cpu[0]?.value ?? null,
    mem: used[0] && total[0]?.value ? used[0].value / total[0].value : null,
    disk: disk[0] ? disk[0].value / 100 : null,
  }
}

async function agentHosts($: EngineInterface, token: string, now: number): Promise<Host[]> {
  const limit = AGENTS.length * 16
  const [cpu, mem, fs] = await Promise.all([
    query($, token, 'devices', 'system.cpu.utilization', limit),
    query($, token, 'devices', 'system.memory.utilization', limit),
    query($, token, 'devices', 'system.filesystem.utilization', limit),
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
    }
  })
}

async function refresh($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  // Sessions share one fetch: a snapshot another session stored recently is reused.
  const cached = (await $.store.get('snap')) as Snapshot | undefined
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
      const pve = await Promise.all(PVE_NODES.map(n => pveHost($, token, now, n)))
      next = { fetchedAt: now, hosts: [...pve, ...(await agentHosts($, token, now))], error: null }
    } catch (err) {
      next = { fetchedAt: now, hosts: cached?.hosts ?? [], error: String((err as Error).message ?? err) }
    }
  }
  await $.store.set('snap', next)
  await update($, snap, () => next)
}

function pct(v: number | null): string {
  return v === null ? '–' : `${Math.round(v * 100)}%`
}

function level(v: number | null): string | undefined {
  if (v === null) return undefined
  if (v >= 0.9) return 'red'
  if (v >= 0.75) return 'yellow'
  return undefined
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
    const mine = (
      <Box paddingX={1} flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Text dimColor>💻 cpu mem disk</Text>
        {s.hosts.map(host => {
          const online = host.ageS !== null && host.ageS <= ONLINE_S
          return (
            <Box key={host.name} flexDirection="row">
              <Text color={online ? 'green' : 'red'}>● </Text>
              <Text dimColor={!online}>{host.name} </Text>
              {online ? (
                <Text>
                  <Text color={level(host.cpu)}>{pct(host.cpu)}</Text>{' '}
                  <Text color={level(host.mem)}>{pct(host.mem)}</Text>{' '}
                  <Text color={level(host.disk)}>{pct(host.disk)}</Text>
                </Text>
              ) : (
                <Text dimColor>{host.ageS === null ? 'no data' : `${Math.round(host.ageS / 60)}m ago`}</Text>
              )}
            </Box>
          )
        })}
        {s.error ? <Text color="red">{s.error}</Text> : null}
      </Box>
    )
    return (
      <Box flexDirection="column">
        {mine}
        {await next(e)}
      </Box>
    )
  })
}
