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

/** A fresh server: set up, data-center mode, running, no validator key yet. */
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

/** What doctl answers, by its command, for a holder who is signed in. */
const DOCTL: Record<string, unknown> = {
  'account get': { status: 'active', email: 'holder@example.com' },
  'compute ssh-key list': [{ id: 7, fingerprint: 'aa:bb', name: 'laptop' }],
  'compute droplet list': [
    {
      id: 101,
      name: '6529-validator-fra1-1',
      status: 'active',
      created_at: '2026-01-01T00:00:00Z',
      region: { slug: 'fra1' },
      size_slug: 's-4vcpu-8gb',
      networks: { v4: [{ ip_address: '203.0.113.9', type: 'public' }] },
    },
  ],
  'compute region list': [{ slug: 'fra1', name: 'Frankfurt 1', available: true, sizes: ['s-4vcpu-8gb'] }],
  'compute size list': [{ slug: 's-4vcpu-8gb', memory: 8192, vcpus: 4, disk: 160, price_monthly: 48 }],
}

const BIN = '/data/bin/doctl'
const out = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: exitCode ? 'failed' : '', isStdoutTruncated: false, isStderrTruncated: false },
})

type On = Parameters<TestBody>[1]

/** The engine beneath the mod: doctl in a given state, plus ssh and the key files. */
function engine(on: On, doctl: 'missing' | 'signed-out' | 'signed-in', ran: string[][]) {
  on('command.register', () => ({ value: { command: 'validator' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/data' } }))
  on('http.fetch', () => ({ value: { status: 0, ok: false, headers: {}, text: '' } }))
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    ran.push(argv)
    const [cmd, ...rest] = argv

    if (cmd === 'printenv') return out('/home/holder\n')
    if (cmd === 'cat') return out('ssh-ed25519 AAAA holder\n')
    if (cmd === 'ssh-keygen') return out('256 MD5:aa:bb holder (ED25519)\n')
    if (cmd === 'ssh') return out(PROBE_OUT)

    if (cmd === BIN && doctl !== 'missing') {
      if (rest[0] === 'version') return out('doctl version 2.7.0-release\n')
      if (rest[0] === 'auth') return out('Validating token... OK\n')
      if (doctl === 'signed-out') return out('', 1)
      const words = rest.filter((a) => !a.startsWith('-'))
      const body = DOCTL[words.slice(0, words[0] === 'account' ? 2 : 3).join(' ')]
      return body ? out(JSON.stringify(body)) : out('', 1)
    }

    return out('', 127)
  })
}

const start = async ($: Engine) => {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'validator', args: '' } as Parameters<typeof $.command.run>[0])
}

test('signed in, a fresh server walks to the tunnel square, on every surface', async ($, on) => {
  const ran: string[][] = []
  engine(on, 'signed-in', ran)
  await start($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'recheck' })

    expect((await ui.find({ type: 'Text', text: /^next/ }))?.text).toContain('tunnel')
    expect(await ui.find({ type: 'Button', key: 'page' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'tunnel' })).toBeDefined()
    await ui.unmount()
  }

  // The probe reaches the server as root over the holder's own key, with a known_hosts of the mod's own.
  const ssh = ran.find((argv) => argv[0] === 'ssh')
  expect(ssh).toContain('root@203.0.113.9')
  expect(ssh).toContain('/home/holder/.ssh/id_ed25519')
  expect(ssh).toContain('UserKnownHostsFile=/data/known_hosts')
})

test('with no doctl, the first square offers to install it and nothing else runs', async ($, on) => {
  const ran: string[][] = []
  engine(on, 'missing', ran)
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'recheck' })

  expect((await ui.find({ type: 'Text', text: /^next/ }))?.text).toContain('not installed')
  expect(await ui.find({ type: 'Button', key: 'install-doctl' })).toBeDefined()
  expect(ran.some((argv) => argv[0] === 'ssh')).toBe(false)
  await ui.unmount()
})

test('signed out, the token goes to doctl auth init and nowhere else', async ($, on) => {
  const ran: string[][] = []
  engine(on, 'signed-out', ran)
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'recheck' })
  expect(await ui.find({ type: 'Input', key: 'token' })).toBeDefined()

  await ui.input({ key: 'token', text: 'dop_v1_secret' })

  const withToken = ran.filter((argv) => argv.includes('dop_v1_secret'))
  expect(withToken).toEqual([[BIN, 'auth', 'init', '--access-token', 'dop_v1_secret']])
  await ui.unmount()
})
