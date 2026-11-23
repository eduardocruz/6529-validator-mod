/** How a square reads: not checked yet, working, done, failed, or waiting on time or on you. */
export type SquareState = 'gray' | 'running' | 'green' | 'red' | 'waiting'

export type Square = { state: SquareState; note?: string }

/** The squares, in the order a setup walks them. */
export type SquareId =
  | 'doctl'
  | 'key'
  | 'droplet'
  | 'ssh'
  | 'setup'
  | 'firewall'
  | 'package'
  | 'mode'
  | 'service'
  | 'tunnel'
  | 'wallet'
  | 'signing'

export type Checks = Partial<Record<SquareId, Square>>

/** A droplet tagged 6529-validator on the holder's own account. */
export type Server = {
  id: number
  name: string
  region: string
  size: string
  ip?: string
  status: string
  createdAt?: string
}

export type Region = { slug: string; name: string; continent: string }
export type Size = { slug: string; memoryGb: number; vcpus: number; diskGb: number; priceMonthly: number }

export type Board = {
  /** The two squares about this computer: doctl, and the SSH key on DigitalOcean. */
  account: Checks
  servers: Server[]
  /** The server squares, by droplet id. */
  byServer: Record<string, Checks>
  /** The last lines of the setup log, by droplet id, shown under a red square. */
  logTail: Record<string, string>
  regions: Region[]
  sizes: Size[]
  /** The private key the servers trust, as the holder chose it; absent until chosen. */
  keyPath?: string
  at?: string
}

export type Picks = { region?: string; size: string }

declare module 'claude-code' {
  interface PluginState {
    '6529-validator-mod': {
      board: Shaped<Board>
      selected: string
      picks: Picks
      note: string
      busy: boolean
      tunnels: Record<string, boolean>
    }
  }
}
