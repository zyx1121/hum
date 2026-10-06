export type Host = {
  name: string
  /** Seconds since the newest point; null when nothing arrived in the window. */
  ageS: number | null
  cpu: number | null
  mem: number | null
  disk: number | null
}

export type Snapshot = { fetchedAt: number; hosts: Host[]; error: string | null }

declare module 'claude-code' {
  interface PluginState {
    hum: { snap: Snapshot | null }
  }
}
