import { expect, test } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'

const PANE = {
  plugin: '6529-validator-mod',
  component: 'Pane',
  requestId: 'validator',
  props: {
    title: '6529 validator',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

/** A fresh server: set up, data-center ("rack") mode, running, no validator key yet. */
const PROBE_OUT = [
  '@@setup done',
  '@@fw_tcp 1',
  '@@fw_udp 1',
  '@@pkg 0.1.0-rc.25',
  '@@sum 1',
  '@@svc active',
  '@@status',
  JSON.stringify({ mode: 'rack', today: 20780, keys: [], update: { state: 'CURRENT' } }),
  '@@tail',
  '== setup finished',
  '@@end',
].join('\n')

const droplet = (createdAt: string) => ({
  id: 101,
  name: '6529-validator-fra1-1',
  status: 'active',
  created_at: createdAt,
  region: { slug: 'fra1' },
  size_slug: 's-4vcpu-8gb',
  networks: { v4: [{ ip_address: '203.0.113.9', type: 'public' }] },
})

const BIN = '/data/bin/doctl'
const KEY = '/home/holder/.ssh/holder'
const out = (stdout: string, exitCode = 0, stderr = '') => ({
  value: { exitCode, stdout, stderr: stderr || (exitCode ? 'failed' : ''), isStdoutTruncated: false, isStderrTruncated: false },
})

type On = Parameters<TestBody>[1]
type World = {
  doctl: 'missing' | 'signed-out' | 'signed-in'
  sshRefused?: boolean
  foreignKey?: boolean
  passphrase?: boolean
  storedKey?: string
  newServer?: boolean
  keyNotOnDo?: boolean
}

/** The engine beneath the mod: doctl in a given state, ssh, the key files and the store. */
function engine(on: On, world: World, ran: string[][], stored: Record<string, unknown> = {}) {
  if (world.storedKey) stored['ssh-key-path'] = world.storedKey
  on('command.register', () => ({ value: { command: 'validator' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/data' } }))
  on('http.fetch', () => ({ value: { status: 0, ok: false, headers: {}, text: '' } }))
  on('fs.write', () => ({ value: undefined }))
  on('store.get', (_, e) => ({ value: stored[e.key] }))
  on('store.set', (_, e) => {
    stored[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    delete stored[e.key]
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    ran.push(argv)
    const [cmd, ...rest] = argv

    if (cmd === 'printenv') return out('/home/holder\n')
    if (cmd === 'mkdir' || cmd === 'chmod') return out('')
    if (cmd === 'test') {
      if (rest[0] === '-L') return out('', 1)
      if (rest[0] === '-O') return out('', world.foreignKey ? 1 : 0)
      return out('', String(rest[1]).endsWith('.pub') && world.passphrase ? 1 : 0)
    }
    if (cmd === 'cat') return world.passphrase ? out('', 1) : out('ssh-ed25519 AAAA holder\n')
    if (cmd === 'ssh-keygen' && rest[0] === '-y') return world.passphrase ? out('', 1, 'incorrect passphrase supplied') : out('ssh-ed25519 AAAA holder\n')
    if (cmd === 'ssh-keygen') return out('256 MD5:aa:bb holder (ED25519)\n')
    if (cmd === 'ssh') {
      return world.sshRefused ? out('', 255, 'root@203.0.113.9: Permission denied (publickey).') : out(PROBE_OUT)
    }

    if (cmd === BIN && world.doctl !== 'missing') {
      if (rest[0] === 'version') return out('doctl version 2.7.0-release\n')
      if (rest[0] === 'auth') return out('Validating token... OK\n')
      if (world.doctl === 'signed-out') return out('', 1)
      const words = rest.filter((a) => !a.startsWith('-'))
      const command = words.slice(0, words[0] === 'account' ? 2 : 3).join(' ')
      const answers: Record<string, unknown> = {
        'account get': { status: 'active', email: 'holder@example.com' },
        'compute ssh-key list': world.keyNotOnDo ? [] : [{ id: 7, fingerprint: 'aa:bb', name: 'laptop' }],
        'compute droplet list': [droplet(world.newServer ? new Date().toISOString() : '2026-01-01T00:00:00Z')],
        'compute region list': [{ slug: 'fra1', name: 'Frankfurt 1', available: true, sizes: ['s-4vcpu-8gb'] }],
        'compute size list': [{ slug: 's-4vcpu-8gb', memory: 8192, vcpus: 4, disk: 160, price_monthly: 48 }],
      }
      return answers[command] ? out(JSON.stringify(answers[command])) : out('', 1)
    }

    return out('', 127)
  })
}

const start = async ($: Engine) => {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'validator', args: '' } as Parameters<typeof $.command.run>[0])
}

const next = async (ui: { find: (q: { type: 'Text'; text: RegExp }) => Promise<{ text?: string } | undefined> }) =>
  (await ui.find({ type: 'Text', text: /^next/ }))?.text ?? ''

test('with a key chosen, a fresh server walks to the tunnel square, on every surface', async ($, on) => {
  const ran: string[][] = []
  engine(on, { doctl: 'signed-in', storedKey: '~/.ssh/holder' }, ran)
  await start($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'recheck' })

    expect(await next(ui)).toContain('tunnel')
    expect(await ui.find({ type: 'Button', key: 'page' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'tunnel' })).toBeDefined()
    await ui.unmount()
  }

  // The probe reaches the server as root over the holder's own key, with a known_hosts of the mod's own.
  const ssh = ran.find((argv) => argv[0] === 'ssh')
  expect(ssh).toContain('root@203.0.113.9')
  expect(ssh).toContain(KEY)
  expect(ssh).toContain('UserKnownHostsFile=/data/known_hosts')
})

test('with no key chosen, the pane asks for one and reads only its public half', async ($, on) => {
  const ran: string[][] = []
  const stored: Record<string, unknown> = {}
  engine(on, { doctl: 'signed-in' }, ran, stored)
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'recheck' })

  expect(await next(ui)).toContain('choose the SSH key')
  expect(await ui.find({ type: 'Button', key: 'make-key' })).toBeDefined()
  expect(ran.some((argv) => argv[0] === 'ssh')).toBe(false)

  await ui.input({ key: 'key-path', text: '~/.ssh/holder' })

  expect(stored['ssh-key-path']).toBe('~/.ssh/holder')
  expect(ran).toContainEqual(['ssh-keygen', '-y', '-P', '', '-f', KEY])
  await ui.unmount()
})

test('once a key is chosen but not on DigitalOcean, the pane offers to add it and hides the form', async ($, on) => {
  const ran: string[][] = []
  engine(on, { doctl: 'signed-in', storedKey: '~/.ssh/holder', keyNotOnDo: true }, ran)
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'recheck' })

  expect(await next(ui)).toContain('not on your DigitalOcean account')
  expect(await ui.find({ type: 'Button', key: 'add-key' })).toBeDefined()
  expect(await ui.find({ type: 'Input', key: 'key-path' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /key: .*\.ssh\/holder/ })).toBeDefined()
  await ui.unmount()
})

test('a passphrase key with no .pub is not stored, and the pane says to ssh-add it', async ($, on) => {
  const ran: string[][] = []
  const stored: Record<string, unknown> = {}
  engine(on, { doctl: 'signed-in', passphrase: true }, ran, stored)
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'recheck' })
  await ui.input({ key: 'key-path', text: '~/.ssh/holder' })

  expect(stored['ssh-key-path']).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /ssh-add/ })).toBeDefined()
  await ui.unmount()
})

test('with no doctl, the first square offers to install it and nothing else runs', async ($, on) => {
  const ran: string[][] = []
  engine(on, { doctl: 'missing' }, ran)
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'recheck' })

  expect(await next(ui)).toContain('not installed')
  expect(await ui.find({ type: 'Button', key: 'install-doctl' })).toBeDefined()
  expect(ran.some((argv) => argv[0] === 'ssh')).toBe(false)
  await ui.unmount()
})

test('signed out, the token goes to doctl auth init and nowhere else', async ($, on) => {
  const ran: string[][] = []
  engine(on, { doctl: 'signed-out' }, ran)
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'recheck' })
  expect(await ui.find({ type: 'Input', key: 'token' })).toBeDefined()

  await ui.input({ key: 'token', text: 'dop_v1_secret' })

  const withToken = ran.filter((argv) => argv.includes('dop_v1_secret'))
  expect(withToken).toEqual([[BIN, 'auth', 'init', '--access-token', 'dop_v1_secret']])
  await ui.unmount()
})

test('a refused key turns ssh red at once, even on a brand-new server', async ($, on) => {
  const ran: string[][] = []
  engine(on, { doctl: 'signed-in', storedKey: '~/.ssh/holder', sshRefused: true, newServer: true }, ran)
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'recheck' })

  const line = await next(ui)
  expect(line).toContain('refused the key')
  expect(line).not.toContain('still starting')
  await ui.unmount()
})

test('a key file the user does not own is refused, and nothing reaches the server', async ($, on) => {
  const ran: string[][] = []
  engine(on, { doctl: 'signed-in', storedKey: '~/.ssh/holder', foreignKey: true }, ran)
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'recheck' })

  expect(await next(ui)).toContain('not a file you own')
  expect(ran.some((argv) => argv[0] === 'ssh')).toBe(false)
  await ui.unmount()
})
