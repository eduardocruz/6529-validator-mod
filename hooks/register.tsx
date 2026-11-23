import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Checks, Picks, Server, Square, SquareId } from '../types'
import {
  DATA_DIR,
  Doctl,
  PROBE,
  REMOTE_PAGE_PORT,
  checkDoctl,
  checkKey,
  expandHome,
  firstOpen,
  installDoctl,
  localLink,
  nextName,
  parseProbe,
  serverSquares,
  sshArgs,
  type Fetch,
  type Run,
} from './core'

const PLUGIN = '6529-validator-mod'
const PANE = 'validator'

const EMPTY: Board = { account: {}, servers: [], byServer: {}, logTail: {}, regions: [], sizes: [] }

// Values a drawing reads live in $.state: a hot reload keeps them.
const board = atom({ plugin: '6529-validator-mod', key: 'board' } as const, EMPTY, { shape: 'board-2' })
const selected = atom({ plugin: '6529-validator-mod', key: 'selected' } as const, '')
const picks = atom({ plugin: '6529-validator-mod', key: 'picks' } as const, { size: 's-4vcpu-8gb' } as Picks)
const note = atom({ plugin: '6529-validator-mod', key: 'note' } as const, '')
const busy = atom({ plugin: '6529-validator-mod', key: 'busy' } as const, false)
const tunnels = atom({ plugin: '6529-validator-mod', key: 'tunnels' } as const, {} as Record<string, boolean>)

const ACCOUNT_SQUARES: { id: SquareId; label: string }[] = [
  { id: 'doctl', label: 'doctl' },
  { id: 'key', label: 'ssh key' },
]

const SERVER_SQUARES: { id: SquareId; label: string }[] = [
  { id: 'droplet', label: 'server' },
  { id: 'ssh', label: 'ssh' },
  { id: 'setup', label: 'setup' },
  { id: 'firewall', label: 'firewall' },
  { id: 'package', label: 'package' },
  { id: 'mode', label: 'mode' },
  { id: 'service', label: 'service' },
  { id: 'tunnel', label: 'tunnel' },
  { id: 'wallet', label: 'wallet' },
  { id: 'signing', label: 'signing' },
]

const ORDER = SERVER_SQUARES.map((s) => s.id)

const GLYPH: Record<Square['state'], { mark: string; color?: string }> = {
  gray: { mark: '□' },
  running: { mark: '◧', color: 'yellow' },
  waiting: { mark: '■', color: 'yellow' },
  green: { mark: '■', color: 'green' },
  red: { mark: '■', color: 'red' },
}

/** Each tunnel is a child process owned by this copy of the module; a reload ends it. */
const children = new Map<string, AsyncGenerator<unknown, unknown>>()
/** Which square's note is shown under the board. Not worth keeping across a reload. */
let focusSquare: SquareId | undefined
let paneOpen = false

/** The options, read once per load of the module. */
// The validator's page checks the port in its address, so the tunnel's local end must be the same port.
const cfg = { sshKey: '~/.ssh/id_ed25519', localPort: REMOTE_PAGE_PORT }

// ------------------------------------------------------------ adapters

function fetcher($: EngineInterface): Fetch {
  return async (url, init) => {
    const r = await $.http.fetch(url, init)
    return { status: r.status, ok: r.ok, text: r.text }
  }
}

function runner($: EngineInterface): Run {
  return async (argv, init) => {
    const r = await $.process.run(argv, { stdin: init?.stdin, timeoutMs: init?.timeoutMs ?? 30000 })
    return { exitCode: r.exitCode ?? -1, stdout: r.stdout, stderr: r.stderr }
  }
}

async function home($: EngineInterface) {
  return (await $.process.run(['printenv', 'HOME'])).stdout.trim()
}

async function paths($: EngineInterface) {
  const env = await $.process.hookEnv()
  return {
    key: expandHome(cfg.sshKey, await home($)),
    knownHosts: `${env.CLAUDE_PLUGIN_DATA ?? '/tmp'}/known_hosts`,
    dataDir: env.CLAUDE_PLUGIN_DATA ?? '/tmp/6529-validator-mod',
  }
}

async function say($: EngineInterface, text: string) {
  await update($, note, () => text)
}

async function setBoard($: EngineInterface, fn: (b: Board) => Board) {
  await update($, board, (b) => fn(b ?? EMPTY))
}

// ------------------------------------------------------------ the checks

/** Reads the truth for every square; changes nothing on any server. */
async function refresh($: EngineInterface) {
  const run = runner($)
  const { key, knownHosts, dataDir } = await paths($)
  const account: Checks = {}

  const found = await checkDoctl(run, dataDir)
  account.doctl = found.square
  const doctl = found.doctl

  if (!doctl || found.square.state !== 'green') {
    await setBoard($, (b) => ({ ...b, account, servers: [], byServer: {}, at: new Date().toISOString() }))
    return
  }

  const keyCheck = await checkKey(run, doctl, key)
  account.key = keyCheck.square

  const [servers, regions, sizes] = await Promise.all([
    doctl.servers(),
    doctl.regions(),
    doctl.sizes(),
  ])

  const tunnelState = await read($, tunnels)
  const byServer: Record<string, Checks> = {}
  const logTail: Record<string, string> = {}

  await Promise.all(
    servers.map(async (server) => {
      const id = String(server.id)

      if (!server.ip) {
        byServer[id] = serverSquares(server, { sshError: 'no address yet' })
        return
      }

      const probe = await run([...sshArgs(key, knownHosts, server.ip), 'bash -s'], {
        stdin: PROBE,
        timeoutMs: 45000,
      }).catch((cause: unknown) => ({ exitCode: 255, stdout: '', stderr: message(cause) }))

      const checks =
        probe.exitCode === 255
          ? serverSquares(server, { sshError: lastLine(probe.stderr) || 'SSH did not connect' })
          : serverSquares(server, parseProbe(probe.stdout))

      if (probe.exitCode !== 255) {
        logTail[id] = parseProbe(probe.stdout).tail
      }

      checks.tunnel = await tunnelSquare($, id, tunnelState[id] === true, checks.service?.state === 'green')
      byServer[id] = checks
    }),
  )

  await setBoard($, () => ({ account, servers, byServer, logTail, regions, sizes, at: new Date().toISOString() }))

  const current = await read($, selected)
  if (!current || (current !== 'new' && !servers.some((s) => String(s.id) === current))) {
    await update($, selected, () => (servers[0] ? String(servers[0].id) : 'new'))
  }
}

/** Green only when the local end of the tunnel actually answers. */
async function tunnelSquare($: EngineInterface, id: string, isOpen: boolean, serviceUp: boolean): Promise<Square> {
  if (!serviceUp) return { state: 'gray', note: 'after the service runs' }
  if (!isOpen) return { state: 'waiting', note: 'closed: press "open tunnel"' }

  const answer = await $.http
    .fetch(`http://127.0.0.1:${cfg.localPort}/`)
    .then((r) => r.status)
    .catch(() => 0)

  return answer > 0
    ? { state: 'green', note: `127.0.0.1:${cfg.localPort} → server ${REMOTE_PAGE_PORT}` }
    : { state: 'running', note: 'opening…' }
}

// ------------------------------------------------------------ the fixes

/** The doctl the mod found, or a clear error naming the square to finish first. */
async function doctlOf($: EngineInterface): Promise<Doctl> {
  const { dataDir } = await paths($)
  const found = await checkDoctl(runner($), dataDir)
  if (!found.doctl || found.square.state !== 'green') throw new Error('finish the doctl square first')
  return found.doctl
}

async function addDoctl($: EngineInterface) {
  const { dataDir } = await paths($)
  const machine = await $.session.machine()
  await installDoctl(runner($), fetcher($), dataDir, { sysname: machine.sysname, machine: machine.machine })
}

/** Hands the token to doctl, which keeps it in its own config; the mod stores nothing. */
async function signIn($: EngineInterface, token: string) {
  const { dataDir } = await paths($)
  const found = await checkDoctl(runner($), dataDir)
  if (!found.doctl) throw new Error('install doctl first')
  const r = await $.process.run([found.doctl.bin, 'auth', 'init', '--access-token', token.trim()], { timeoutMs: 60000 })
  if (r.exitCode !== 0) throw new Error(lastLine(r.stderr || r.stdout) || 'doctl did not accept the token')
}

async function copySignIn($: EngineInterface, surface: string) {
  const { dataDir } = await paths($)
  const found = await checkDoctl(runner($), dataDir)
  await $.ui.copy({ text: `${found.doctl?.bin ?? 'doctl'} auth init`, surface: surface as never })
}

async function addKey($: EngineInterface) {
  const run = runner($)
  const { key } = await paths($)
  const doctl = await doctlOf($)

  const exists = await run(['test', '-f', `${key}.pub`])
  if (exists.exitCode !== 0) {
    await run(['mkdir', '-p', key.replace(/\/[^/]+$/, '')])
    const made = await run(['ssh-keygen', '-t', 'ed25519', '-N', '', '-C', '6529-validator', '-f', key])
    if (made.exitCode !== 0) throw new Error(`ssh-keygen: ${lastLine(made.stderr)}`)
  }

  await doctl.addKey('6529-validator', `${key}.pub`)
}

async function create($: EngineInterface) {
  const run = runner($)
  const { key } = await paths($)
  const doctl = await doctlOf($)
  const chosen = await read($, picks)

  if (!chosen.region) throw new Error('pick a region first')

  const keyCheck = await checkKey(run, doctl, key)
  if (!keyCheck.keyId) throw new Error('add your SSH key to DigitalOcean first')

  const servers = await doctl.servers()
  const server = await doctl.create({
    name: nextName(servers, chosen.region),
    region: chosen.region,
    size: chosen.size,
    keyId: keyCheck.keyId,
    userDataFile: `${$.plugin.root}/cloud-init/validator.yaml`,
  })

  await update($, selected, () => String(server.id))
  return server
}

async function openTunnel($: EngineInterface, server: Server) {
  const id = String(server.id)
  if (children.has(id) || !server.ip) return

  const { key, knownHosts } = await paths($)
  const argv = [
    ...sshArgs(key, knownHosts, server.ip).slice(0, -1),
    '-N',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=30',
    '-L',
    `${cfg.localPort}:127.0.0.1:${REMOTE_PAGE_PORT}`,
    `root@${server.ip}`,
  ]

  const child = $.process.spawn({ argv })
  children.set(id, child)
  await update($, tunnels, (t) => ({ ...t, [id]: true }))

  // The loop is the child's life: it ends when ssh exits or the module unloads.
  void (async () => {
    let said = ''
    try {
      for await (const piece of child) {
        said += (piece as { text?: string }).text ?? ''
      }
    } catch (cause) {
      said += message(cause)
    } finally {
      children.delete(id)
      await update($, tunnels, (t) => ({ ...t, [id]: false }))
      if (said.trim()) await say($, `tunnel closed: ${lastLine(said)}`)
      await refresh($).catch(() => undefined)
    }
  })()
}

async function closeTunnel($: EngineInterface, id: string) {
  await children.get(id)?.return(undefined)
  children.delete(id)
  await update($, tunnels, (t) => ({ ...t, [id]: false }))
}

/** Asks the validator for a one-time link and opens it at the local end of the tunnel. */
async function openPage($: EngineInterface, server: Server) {
  if (!server.ip) throw new Error('the server has no address yet')
  await openTunnel($, server)

  const run = runner($)
  const { key, knownHosts } = await paths($)
  const printed = await run([
    ...sshArgs(key, knownHosts, server.ip),
    `runuser -u validator6529 -- validator open --print --data-dir ${DATA_DIR}`,
  ])
  const link = localLink(printed.stdout, cfg.localPort)

  if (!link) throw new Error(`no link from the validator: ${lastLine(printed.stderr || printed.stdout)}`)

  // Give ssh a moment to bind the local port before the browser asks for it.
  await $.clock.sleep(1500)
  const system = (await $.session.machine()).sysname.toLowerCase()
  const opener =
    system.includes('darwin') ? ['open', link] : system.includes('windows') ? ['cmd', '/c', 'start', '', link] : ['xdg-open', link]
  await run(opener)
}

/** What the pane cannot judge goes to Claude, with what the squares and the log say. */
function diagnose($: EngineInterface, server: Server, checks: Checks, tail: string) {
  const lines = SERVER_SQUARES.map((s) => `- ${s.label}: ${checks[s.id]?.state ?? 'gray'} — ${checks[s.id]?.note ?? ''}`)
  const text = [
    `My 6529 validator server ${server.name} (${server.ip ?? 'no IP'}, ${server.region}, ${server.size}) has a step that is not done. The 6529-validator-mod pane shows:`,
    ...lines,
    tail ? `\nLast lines of /var/log/6529-validator-setup.log:\n\`\`\`\n${tail}\n\`\`\`` : '',
    `\nI can reach it with \`ssh -i ${cfg.sshKey} root@${server.ip}\`. Diagnose what went wrong and tell me the fix. Do not change anything on the server until I agree, and never touch the validator's key or run \`validator init --force\` once a key exists.`,
  ].join('\n')

  return $.prompt.submit({ text })
}

function act($: EngineInterface, label: string, work: () => Promise<unknown>) {
  void (async () => {
    if (await read($, busy)) return
    await update($, busy, () => true)
    await say($, `${label}…`)
    try {
      await work()
      await say($, `${label}: done`)
    } catch (cause) {
      await say($, `${label}: ${message(cause)}`)
    } finally {
      await refresh($).catch(async (cause: unknown) => say($, `re-check: ${message(cause)}`))
      await update($, busy, () => false)
    }
  })()
}

export const register: Register = (on, options) => {
  cfg.sshKey = String(options.sshKey ?? '~/.ssh/id_ed25519')

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'validator',
      description: 'Set up and watch your 6529 validator, step by step, in a pane',
    })

    // While the pane is open and a square is still moving, look again every 20 s.
    $.clock.every(20000, () => {
      void (async () => {
        if (!paneOpen || (await read($, busy))) return
        const b = await read($, board)
        const moving = Object.values(b.byServer).some((checks) =>
          Object.values(checks).some((s) => s?.state === 'waiting' || s?.state === 'running'),
        )
        if (moving) await refresh($).catch(() => undefined)
      })()
    })

    return next(e)
  })

  on('command.run', { command: 'validator' }, async ($) => {
    paneOpen = true
    await $.ui.open({ id: PANE, title: '6529 validator' })
    act($, 'checking', async () => undefined)

    return { text: 'The validator pane is open; every square is being checked.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const b = await read($, board)
    const current = await read($, selected)
    const chosen = await read($, picks)
    const said = await read($, note)
    const working = await read($, busy)
    const open = await read($, tunnels)

    const server = b.servers.find((s) => String(s.id) === current)
    const checks = server ? (b.byServer[String(server.id)] ?? {}) : {}

    const square = (id: SquareId, label: string, s: Square | undefined) => {
      const g = GLYPH[s?.state ?? 'gray']
      return (
        <Box key={`sqbox:${id}`}>
          <Button
            key={`sq:${id}`}
            plain
            hover={{ bold: true }}
            onPress={() => {
              focusSquare = id
              $.ui.invalidate('ui.render')
            }}
          >
            <Text color={g.color} dimColor={!g.color}>{g.mark}</Text> <Text dimColor={!s || s.state === 'gray'}>{label}</Text>
          </Button>
        </Box>
      )
    }

    const accountReady = b.account.doctl?.state === 'green' && b.account.key?.state === 'green'
    // Where a re-run resumes: this computer and the account first, then the server.
    const accountNext = b.account.doctl ? (firstOpen(['doctl', 'key'], b.account) as SquareId | undefined) : undefined
    const next = accountNext ?? (server ? (firstOpen(ORDER, checks) as SquareId | undefined) : undefined)
    const shown = focusSquare && (checks[focusSquare] || b.account[focusSquare]) ? focusSquare : next
    const shownSquare = shown ? (checks[shown] ?? b.account[shown]) : undefined
    const shownLabel = [...ACCOUNT_SQUARES, ...SERVER_SQUARES].find((s) => s.id === shown)?.label

    const detail = shownSquare && (
      <Text wrap="wrap">
        <Text bold>{shown === next ? 'next' : shownLabel}</Text>
        {shown === next && shownLabel ? ` · ${shownLabel}` : ''}: {shownSquare.note ?? shownSquare.state}
      </Text>
    )

    return (
      <Box flexDirection="column" padding={1} gap={1}>
        <Box justifyContent="space-between">
          <Text bold>6529 validator</Text>
          <Box columnGap={1}>
            <Text dimColor>{working ? 'working…' : clock(b.at)}</Text>
            <Button key="recheck" label="re-check" onPress={() => act($, 'checking', async () => undefined)} />
          </Box>
        </Box>

        <Box columnGap={2} flexWrap="wrap">
          {ACCOUNT_SQUARES.map((s) => square(s.id, s.label, b.account[s.id]))}
          {b.account.doctl?.state === 'red' && (
            <Button key="install-doctl" label="install doctl" variant="primary" onPress={() => act($, 'installing doctl', () => addDoctl($))} />
          )}
          {b.account.doctl?.state === 'green' && b.account.key && b.account.key.state !== 'green' && (
            <Button key="add-key" label="add my key to DigitalOcean" onPress={() => act($, 'adding your key', () => addKey($))} />
          )}
        </Box>

        {b.account.doctl?.state === 'waiting' && (
          <Box flexDirection="column" gap={1}>
            <Text wrap="wrap">
              Make a token at cloud.digitalocean.com/account/api/tokens and paste it here. doctl keeps it in its own settings on this computer; this pane keeps nothing.
            </Text>
            <Input
              key="token"
              label="DigitalOcean token"
              placeholder="dop_v1_…"
              submitLabel="sign in"
              onSubmit={(value: string) => act($, 'signing in to DigitalOcean', () => signIn($, value))}
            />
            <Box columnGap={1}>
              <Text dimColor>or run it in a terminal:</Text>
              <Button key="copy-signin" label="copy sign-in command" onPress={() => act($, 'copying', () => copySignIn($, e.surface))} />
            </Box>
          </Box>
        )}
        {!server && detail}

        {b.account.doctl?.state === 'green' && (
          <Box columnGap={1} flexWrap="wrap">
            {b.servers.map((s) => (
              <Button
                key={`srv:${s.id}`}
                label={s.name.replace('6529-validator-', '')}
                variant={String(s.id) === current ? 'primary' : undefined}
                onPress={() => {
                  focusSquare = undefined
                  void update($, selected, () => String(s.id))
                }}
              />
            ))}
            <Button
              key="srv:new"
              label="+ new server"
              variant={current === 'new' ? 'primary' : undefined}
              onPress={() => void update($, selected, () => 'new')}
            />
          </Box>
        )}

        {server && (
          <Box flexDirection="column" gap={1}>
            <Text dimColor wrap="truncate-end">
              {server.name} · {server.size} · {server.ip ?? 'no address yet'}
            </Text>
            <Box columnGap={2} rowGap={0} flexWrap="wrap">
              {SERVER_SQUARES.map((s) => square(s.id, s.label, checks[s.id]))}
            </Box>
            {detail}
            {!next && server && <Text color="green">All done. Your validator signs every day; open this pane to check on it.</Text>}
            <Box columnGap={1} flexWrap="wrap">
              {checks.service?.state === 'green' &&
                (open[String(server.id)] ? (
                  <Button key="tunnel" label="close tunnel" onPress={() => act($, 'closing the tunnel', () => closeTunnel($, String(server.id)))} />
                ) : (
                  <Button key="tunnel" label="open tunnel" onPress={() => act($, 'opening the tunnel', () => openTunnel($, server))} />
                ))}
              {checks.service?.state === 'green' && (
                <Button
                  key="page"
                  label={checks.wallet?.state === 'green' ? 'open page' : 'open page to sign'}
                  variant={checks.wallet?.state !== 'green' ? 'primary' : undefined}
                  onPress={() => act($, 'opening the validator page', () => openPage($, server))}
                />
              )}
              {Object.values(checks).some((s) => s?.state === 'red') && (
                <Button
                  key="diagnose"
                  label="diagnose with Claude"
                  onPress={() =>
                    act($, 'asking Claude', () => diagnose($, server, checks, b.logTail[String(server.id)] ?? ''))
                  }
                />
              )}
            </Box>
            {checks.setup?.state === 'red' && b.logTail[String(server.id)] && (
              <Text dimColor wrap="wrap">{b.logTail[String(server.id)]}</Text>
            )}
          </Box>
        )}

        {current === 'new' && accountReady && (
          <Box flexDirection="column" gap={1}>
            <Text bold>Where should it run?</Text>
            {continents(b.regions).map(([continent, regions]) => (
              <Box key={`c:${continent}`} columnGap={1} flexWrap="wrap">
                <Box width={14} flexShrink={0}>
                  <Text dimColor>{continent}</Text>
                </Box>
                {regions.map((r) => {
                  const mine = b.servers.some((s) => s.region === r.slug)
                  return (
                    <Button
                      key={`r:${r.slug}`}
                      label={`${r.slug}${mine ? ' •' : ''}`}
                      variant={chosen.region === r.slug ? 'primary' : undefined}
                      onPress={() => void update($, picks, (p) => ({ ...p, region: r.slug }))}
                    />
                  )
                })}
              </Box>
            ))}
            <Text dimColor>• you already have one there; another continent helps the network more</Text>

            <Text bold>How big?</Text>
            <Box columnGap={1} flexWrap="wrap">
              {b.sizes.map((s) => (
                <Button
                  key={`s:${s.slug}`}
                  label={`${s.memoryGb} GB · $${s.priceMonthly}/mo${s.slug === 's-4vcpu-8gb' ? ' · recommended' : ''}`}
                  variant={chosen.size === s.slug ? 'primary' : undefined}
                  onPress={() => void update($, picks, (p) => ({ ...p, size: s.slug }))}
                />
              ))}
            </Box>
            <Text dimColor wrap="wrap">
              8 GB is 6529's cloud guidance. 4 GB finished a sync in a test but sits below it. The bill is DigitalOcean's, on your account; destroying the server stops it.
            </Text>
            <Button
              key="create"
              label={chosen.region ? `create server in ${chosen.region}` : 'pick a region'}
              variant="primary"
              onPress={() => act($, 'creating your server', () => create($))}
            />
          </Box>
        )}

        {current === 'new' && !accountReady && b.account.doctl && (
          <Text dimColor>Finish the two squares above first.</Text>
        )}

        {said && <Text dimColor wrap="wrap">{said}</Text>}
        <Text dimColor>click a square for its detail · /validator</Text>
      </Box>
    )
  })
}

const continents = (regions: Board['regions']) => {
  const groups = new Map<string, Board['regions']>()
  for (const r of regions) groups.set(r.continent, [...(groups.get(r.continent) ?? []), r])
  return [...groups.entries()]
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

const lastLine = (text: string) =>
  text
    .trim()
    .split('\n')
    .filter((l) => l.trim())
    .pop() ?? ''

const clock = (iso: string | undefined) => {
  if (!iso) return ''
  const at = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}
