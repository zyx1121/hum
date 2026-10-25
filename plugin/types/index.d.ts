export type Host = {
  name: string
  /** Seconds since the newest point; null when nothing arrived in the window. */
  ageS: number | null
  cpu: number | null
  mem: number | null
  disk: number | null
  /** Busiest GPU, 0..1; null on machines without one. */
  gpu: number | null
  /** Received plus sent, bytes per second, over the two newest readings. */
  net: number | null
  /** Hottest temp-watch sensor in degrees C, toned against its limit; absent where nothing reports. */
  temp?: { c: number; tone: 'normal' | 'warn' | 'error' | 'dim' } | null
  /** Set on a cluster panel: nodes reporting, out of all its nodes. */
  nodes?: { up: number; total: number }
}

export type Snapshot = { fetchedAt: number; hosts: Host[]; error: string | null }

declare module 'claude-code' {
  interface PluginState {
    hum: { snap: Snapshot | null }
  }
}
