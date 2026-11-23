/**
 * Everything the mod knows about DigitalOcean, the server and the validator,
 * with no Claude Code in it: the engine hands in `fetch` and `run`, so this
 * file runs the same under the engine, under a test and under plain Node.
 *
 * Every square is a CHECK first. A fix only runs for a square that is not
 * green, so running the whole board again is always safe: it re-reads the
 * truth and resumes at the first square that is not done.
 */
import type { Checks, Region, Server, Size, Square } from '../types'

export type Fetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; text: string }>

export type Run = (
  argv: string[],
  init?: { stdin?: string; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export const TAG = '6529-validator'
/** The validator page's port on the server, fixed by the cloud-init. */
export const REMOTE_PAGE_PORT = 16529
export const DATA_DIR = '/var/lib/6529-validator'
/** Ubuntu 24.04 LTS, the release 6529's cloud guide is written against. */
export const IMAGE = 'ubuntu-24-04-x64'

/**
 * The two plans offered. 8 GB is what 6529's rc.25 cloud guide recommends;
 * 4 GB finished an initial sync in a test but sits below that guidance.
 */
export const SIZES = [
  { slug: 's-4vcpu-8gb', recommended: true },
  { slug: 's-2vcpu-4gb', recommended: false },
] as const

const CONTINENT: Record<string, string> = {
  nyc: 'North America',
  sfo: 'North America',
  tor: 'North America',
  atl: 'North America',
  ric: 'North America',
  lon: 'Europe',
  ams: 'Europe',
  fra: 'Europe',
  blr: 'Asia',
  sgp: 'Asia',
  syd: 'Oceania',
}

export const continentOf = (slug: string) => CONTINENT[slug.replace(/\d+$/, '')] ?? 'Other'

const ok = (note?: string): Square => ({ state: 'green', note })
const bad = (note: string): Square => ({ state: 'red', note })
const wait = (note: string): Square => ({ state: 'waiting', note })

// ---------------------------------------------------------------- doctl

/**
 * DigitalOcean is reached only through doctl, DigitalOcean's own CLI. The
 * holder signs in to doctl; this mod never sees, stores or sends the token.
 */
export class Doctl {
  private readonly run: Run
  readonly bin: string

  constructor(run: Run, bin: string) {
    this.run = run
    this.bin = bin
  }

  async json<T>(args: string[]): Promise<T> {
    const r = await this.run([this.bin, ...args, '--output', 'json'], { timeoutMs: 120000 })
    if (r.exitCode !== 0) {
      throw new Error(`doctl ${args.slice(0, 3).join(' ')}: ${lastLine(r.stderr || r.stdout) || `exit ${r.exitCode}`}`)
    }
    const text = r.stdout.trim()
    return (text && text !== 'null' ? JSON.parse(text) : []) as T
  }

  async account(): Promise<{ email?: string; status?: string }> {
    const a = await this.json<{ email?: string; status?: string } | { email?: string; status?: string }[]>(['account', 'get'])
    return Array.isArray(a) ? (a[0] ?? {}) : a
  }

  async keys(): Promise<{ id: number; fingerprint: string; name: string }[]> {
    return this.json(['compute', 'ssh-key', 'list'])
  }

  /** Returns the new key's id: DigitalOcean's key list lags a few seconds behind an import. */
  async addKey(name: string, publicKeyFile: string): Promise<{ id: number; fingerprint: string }> {
    const added = await this.json<{ id: number; fingerprint: string }[]>([
      'compute', 'ssh-key', 'import', name, '--public-key-file', publicKeyFile,
    ])
    if (!added[0]) throw new Error('doctl imported no key')
    return added[0]
  }

  async servers(): Promise<Server[]> {
    const droplets = await this.json<Droplet[]>(['compute', 'droplet', 'list', '--tag-name', TAG])
    return droplets.map(toServer).sort((a, b) => a.id - b.id)
  }

  async regions(): Promise<Region[]> {
    const regions = await this.json<{ slug: string; name: string; available: boolean; sizes: string[] }[]>([
      'compute', 'region', 'list',
    ])
    return regions
      .filter((r) => r.available && SIZES.some((s) => r.sizes.includes(s.slug)))
      .map((r) => ({ slug: r.slug, name: r.name, continent: continentOf(r.slug) }))
      .sort((a, b) => a.continent.localeCompare(b.continent) || a.slug.localeCompare(b.slug))
  }

  async sizes(): Promise<Size[]> {
    const sizes = await this.json<{ slug: string; memory: number; vcpus: number; disk: number; price_monthly: number }[]>([
      'compute', 'size', 'list',
    ])
    return SIZES.flatMap((wanted) => {
      const s = sizes.find((one) => one.slug === wanted.slug)
      return s
        ? [{ slug: s.slug, memoryGb: s.memory / 1024, vcpus: s.vcpus, diskGb: s.disk, priceMonthly: s.price_monthly }]
        : []
    })
  }

  async create(input: { name: string; region: string; size: string; keyId: number; userDataFile: string }): Promise<Server> {
    const made = await this.json<Droplet[]>([
      'compute', 'droplet', 'create', input.name,
      '--region', input.region,
      '--size', input.size,
      '--image', IMAGE,
      '--ssh-keys', String(input.keyId),
      '--user-data-file', input.userDataFile,
      '--tag-names', TAG,
      '--enable-monitoring',
    ])
    if (!made[0]) throw new Error('doctl created no droplet')
    return toServer(made[0])
  }

  async destroy(id: number): Promise<void> {
    const r = await this.run([this.bin, 'compute', 'droplet', 'delete', String(id), '--force'], { timeoutMs: 60000 })
    if (r.exitCode !== 0) throw new Error(`doctl droplet delete: ${lastLine(r.stderr)}`)
  }
}

/** Where doctl may already be, then the copy this mod installs. */
export const doctlCandidates = (dataDir: string) => [
  `${dataDir}/bin/doctl`,
  'doctl',
  '/opt/homebrew/bin/doctl',
  '/usr/local/bin/doctl',
  '/snap/bin/doctl',
]

export async function findDoctl(run: Run, dataDir: string): Promise<string | undefined> {
  for (const bin of doctlCandidates(dataDir)) {
    const r = await run([bin, 'version']).catch(() => ({ exitCode: -1, stdout: '', stderr: '' }))
    if (r.exitCode === 0) return bin
  }
  return undefined
}

/** The doctl square: installed, then signed in. */
export async function checkDoctl(run: Run, dataDir: string): Promise<{ square: Square; doctl?: Doctl }> {
  const bin = await findDoctl(run, dataDir)
  if (!bin) return { square: bad('doctl, DigitalOcean\'s own command line tool, is not installed') }

  const doctl = new Doctl(run, bin)
  try {
    const who = await doctl.account()
    return { square: ok(`signed in${who.email ? ` as ${who.email}` : ''}`), doctl }
  } catch {
    return { square: wait('installed; sign in to DigitalOcean'), doctl }
  }
}

/** doctl's release build for this machine, as GitHub names it. */
export const doctlAsset = (version: string, sysname: string, machine: string) => {
  const os = sysname.toLowerCase().includes('darwin') ? 'darwin' : 'linux'
  const arch = /arm64|aarch64/.test(machine) ? 'arm64' : 'amd64'
  return `doctl-${version}-${os}-${arch}.tar.gz`
}

/**
 * Downloads DigitalOcean's release of doctl for this machine into the mod's own
 * data folder, checks it against the release's SHA-256 list, and unpacks it.
 * No package manager, no sudo, nothing outside that folder.
 */
export async function installDoctl(
  run: Run,
  fetch: Fetch,
  dataDir: string,
  machine: { sysname: string; machine: string },
): Promise<string> {
  const release = await fetch('https://api.github.com/repos/digitalocean/doctl/releases/latest', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': '6529-validator-mod' },
  })
  if (!release.ok) throw new Error(`GitHub answered ${release.status} for doctl's latest release`)

  const version = (JSON.parse(release.text) as { tag_name: string }).tag_name.replace(/^v/, '')
  const asset = doctlAsset(version, machine.sysname, machine.machine)
  const base = `https://github.com/digitalocean/doctl/releases/download/v${version}`
  const dl = `${dataDir}/download`
  const bin = `${dataDir}/bin`

  const step = async (argv: string[], what: string) => {
    const r = await run(argv, { timeoutMs: 180000 })
    if (r.exitCode !== 0) throw new Error(`${what}: ${lastLine(r.stderr || r.stdout) || `exit ${r.exitCode}`}`)
    return r.stdout
  }

  await step(['mkdir', '-p', dl, bin], 'making the folder')
  await step(['curl', '-fsSL', '-o', `${dl}/${asset}`, `${base}/${asset}`], 'downloading doctl')
  const sums = await step(['curl', '-fsSL', `${base}/doctl-${version}-checksums.sha256`], 'downloading the checksums')

  const expected = sums
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find(([, name]) => name === asset)?.[0]
  if (!expected) throw new Error(`no checksum listed for ${asset}`)

  const hashed =
    (await run(['shasum', '-a', '256', `${dl}/${asset}`]).catch(() => undefined)) ??
    (await run(['sha256sum', `${dl}/${asset}`]))
  const actual = hashed.stdout.trim().split(/\s+/)[0]
  if (hashed.exitCode !== 0 || actual !== expected) {
    await run(['rm', '-f', `${dl}/${asset}`])
    throw new Error(`doctl's checksum did not match (expected ${expected.slice(0, 12)}…, got ${(actual ?? '').slice(0, 12)}…); nothing installed`)
  }

  await step(['tar', '-xzf', `${dl}/${asset}`, '-C', bin, 'doctl'], 'unpacking doctl')
  await step(['chmod', '755', `${bin}/doctl`], 'making doctl runnable')
  await run(['rm', '-rf', dl])
  return `${bin}/doctl`
}

type Droplet = {
  id: number
  name: string
  status: string
  created_at?: string
  region: { slug: string }
  size_slug: string
  networks?: { v4?: { ip_address: string; type: string }[] }
}

const toServer = (d: Droplet): Server => ({
  id: d.id,
  name: d.name,
  region: d.region.slug,
  size: d.size_slug,
  ip: d.networks?.v4?.find((n) => n.type === 'public')?.ip_address,
  status: d.status,
  createdAt: d.created_at,
})

/** A name nobody has to type: the region and the next free number. */
export const nextName = (servers: Server[], region: string) => {
  const taken = new Set(servers.map((s) => s.name))
  for (let n = 1; ; n++) {
    const name = `${TAG}-${region}-${n}`
    if (!taken.has(name)) return name
  }
}

// ---------------------------------------------------------------- local key

/** `~/x` → `$HOME/x`; ssh-keygen and the file reads do not expand it. */
export const expandHome = (path: string, home: string) => (path.startsWith('~/') ? `${home}${path.slice(1)}` : path)

/**
 * The key square: the private key and its .pub exist here, and the .pub is on
 * the DigitalOcean account. DigitalOcean names keys by their MD5 fingerprint.
 */
export async function checkKey(
  run: Run,
  doctl: Doctl,
  privateKey: string,
): Promise<{ square: Square; keyId?: number; publicKey?: string }> {
  const read = await run(['cat', `${privateKey}.pub`])

  if (read.exitCode !== 0) {
    return { square: bad(`no key at ${privateKey}.pub`) }
  }

  const publicKey = read.stdout.trim()
  const print = await run(['ssh-keygen', '-E', 'md5', '-lf', `${privateKey}.pub`])
  const fingerprint = /MD5:([0-9a-f:]+)/.exec(print.stdout)?.[1]

  if (!fingerprint) {
    return { square: bad(`could not read ${privateKey}.pub`), publicKey }
  }

  const found = (await doctl.keys()).find((k) => k.fingerprint === fingerprint)

  return found
    ? { square: ok(`on DigitalOcean as "${found.name}"`), keyId: found.id, publicKey }
    : { square: wait('not on your DigitalOcean account yet'), publicKey }
}

// ---------------------------------------------------------------- the server

export const sshArgs = (privateKey: string, knownHosts: string, ip: string) => [
  'ssh',
  '-i',
  privateKey,
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'StrictHostKeyChecking=accept-new',
  '-o',
  `UserKnownHostsFile=${knownHosts}`,
  `root@${ip}`,
]

/**
 * One SSH round trip reads every server square. Sections start with `@@`;
 * the status JSON and the log tail run until the next one.
 */
export const PROBE = `
set +e
if [ -f /var/lib/6529-validator-setup.done ]; then s=done
elif [ -f /var/lib/6529-validator-setup.failed ]; then s=failed
else s=running; fi
echo "@@setup $s"
u=$(ufw status 2>/dev/null)
echo "@@fw_tcp $(printf '%s' "$u" | grep -c '^4001/tcp .*ALLOW')"
echo "@@fw_udp $(printf '%s' "$u" | grep -c '^4001/udp .*ALLOW')"
echo "@@pkg $(dpkg-query -W -f='\${Version}' 6529-validator 2>/dev/null)"
echo "@@sum $(grep -c '_amd64.deb: OK$' /var/log/6529-validator-setup.log 2>/dev/null)"
echo "@@svc $(systemctl is-active 6529-validator.service 2>/dev/null)"
echo "@@status"
command -v validator >/dev/null && runuser -u validator6529 -- validator status --json --data-dir ${DATA_DIR} 2>/dev/null
echo "@@tail"
tail -n 8 /var/log/6529-validator-setup.log 2>/dev/null
echo "@@end"
`

export type Probe = {
  setup: string
  fwTcp: boolean
  fwUdp: boolean
  pkg: string
  sumOk: boolean
  svc: string
  status?: ValidatorStatus
  tail: string
}

/** The fields of `validator status --json` (StatusSnapshot, format 1) the squares read. */
export type ValidatorStatus = {
  release?: string
  mode?: string
  today?: number
  role?: string
  setup_pending?: unknown[]
  day?: { state?: string; signed?: boolean }
  keys?: { standing?: string; last_signed_day?: number | null; granted_for?: string | null }[]
  update?: { state?: string; latest?: string; newer?: boolean }
}

export function parseProbe(out: string): Probe {
  const single: Record<string, string> = {}
  const block: Record<string, string[]> = {}
  let current: string | undefined

  for (const line of out.split('\n')) {
    const head = /^@@(\w+)(?: (.*))?$/.exec(line)

    if (head) {
      const [, name = '', value] = head
      if (value !== undefined) {
        single[name] = value.trim()
        current = undefined
      } else {
        current = name
        block[name] = []
      }
      continue
    }

    if (current) block[current]?.push(line)
  }

  let status: ValidatorStatus | undefined
  const json = (block.status ?? []).join('\n').trim()

  if (json.startsWith('{')) {
    try {
      status = JSON.parse(json) as ValidatorStatus
    } catch {
      status = undefined
    }
  }

  return {
    setup: single.setup ?? 'unknown',
    fwTcp: Number(single.fw_tcp ?? 0) > 0,
    fwUdp: Number(single.fw_udp ?? 0) > 0,
    pkg: single.pkg ?? '',
    sumOk: Number(single.sum ?? 0) > 0,
    svc: single.svc ?? '',
    status,
    tail: (block.tail ?? []).join('\n').trim(),
  }
}

/** Minutes since the droplet was created, for telling "booting" from "broken". */
const ageMinutes = (server: Server, now: number) =>
  server.createdAt ? (now - Date.parse(server.createdAt)) / 60000 : Number.POSITIVE_INFINITY

/** The server squares from one probe (or from an SSH failure). */
export function serverSquares(server: Server, probe: Probe | { sshError: string }, now = Date.now()): Checks {
  const young = ageMinutes(server, now) < 15
  const checks: Checks = {
    droplet:
      server.status === 'active' && server.ip
        ? ok(`${server.region} · ${server.ip}`)
        : wait(`${server.status}, no address yet`),
  }

  if ('sshError' in probe) {
    checks.ssh = young ? wait('the server is still starting') : bad(probe.sshError)
    return checks
  }

  checks.ssh = ok(`root@${server.ip}`)

  const installing = probe.setup === 'running'
  checks.setup =
    probe.setup === 'done'
      ? ok('setup finished')
      : probe.setup === 'failed'
        ? bad('setup failed: see the log')
        : young
          ? wait('installing, about 5 minutes')
          : bad('setup never finished: see the log')

  checks.firewall =
    probe.fwTcp && probe.fwUdp
      ? ok('22 and 4001 (TCP and QUIC) open, the rest closed')
      : installing
        ? wait('not set yet')
        : bad(`port 4001 ${probe.fwTcp ? 'TCP only' : 'closed'}`)

  checks.package = installing
    ? wait(probe.pkg ? `${probe.pkg}, installing` : 'not installed yet')
    : probe.pkg
    ? probe.sumOk
      ? ok(`${probe.pkg}, checksum matched 6529's SHA256SUMS`)
      : wait(`${probe.pkg}, no checksum line in the log`)
    : installing
      ? wait('not installed yet')
      : bad('not installed')

  const status = probe.status

  if (status?.update?.newer === true && checks.package.state === 'green') {
    checks.package = wait(`${probe.pkg} · update ${status.update.latest ?? 'available'} is out`)
  }

  checks.mode = installing
    ? wait('set by the install script')
    : !status
    ? installing
      ? wait('not set up yet')
      : bad('the validator does not answer')
    : status.mode === 'rack' || status.mode === 'datacenter'
      ? ok('data center: listens publicly, Tor off')
      : bad(`${status.mode ?? 'unknown'} mode: on a server it should be data-center`)

  checks.service = installing
    ? wait('started by the install script')
    : probe.svc === 'active'
      ? ok('running')
      : bad(probe.svc || 'not running')

  const keys = status?.keys ?? []
  const authorized = keys.find((k) => k.standing === 'AUTHORIZED')

  checks.wallet = installing || !status
    ? wait('after setup')
    : authorized
      ? ok(`authorized by ${short(authorized.granted_for)}`)
      : keys.length === 0
        ? wait('open the page, make a key, sign with your wallet')
        : wait(`key ${keys[0]?.standing?.toLowerCase() ?? 'waiting'}: sign with your wallet`)

  const signedToday =
    status?.day?.signed === true || keys.some((k) => k.last_signed_day != null && k.last_signed_day === status?.today)

  checks.signing = !authorized
    ? wait('after the wallet')
    : signedToday
      ? ok(`signed today${status?.role ? ` · ${status.role.toLowerCase()}` : ''}`)
      : wait("waiting for today's window")

  return checks
}

export const lastLine = (text: string) =>
  text
    .trim()
    .split('\n')
    .filter((l) => l.trim())
    .pop() ?? ''

const short = (address: string | null | undefined) =>
  address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'your wallet'

/** The first square that is not green: where a re-run resumes. */
export const firstOpen = (order: readonly string[], checks: Checks) =>
  order.find((id) => checks[id as keyof Checks]?.state !== 'green')

/** The one-time page link, moved to the local end of the tunnel. */
export const localLink = (printed: string, localPort: number) => {
  const url = /https?:\/\/127\.0\.0\.1:\d+\/\S*/.exec(printed)?.[0]
  return url?.replace(/127\.0\.0\.1:\d+/, `127.0.0.1:${localPort}`)
}
