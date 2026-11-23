# 6529 Validator mod for Claude Code

Run a [6529 validator](https://6529.io/validator) on your own DigitalOcean server, without the server work, from a pane beside your Claude Code chat.

The pane shows the setup as a row of squares. Each one turns from gray to green as it is done:

```
 6529 validator                                   13:42 [ re-check ]
 ■ doctl   ■ ssh key
 [ fra1-1 ]  [ + new server ]
 6529-validator-fra1-1 · s-4vcpu-8gb · 203.0.113.9
 ■ server  ■ ssh  ■ setup  ■ firewall  ■ package
 ■ mode    ■ service  ■ tunnel  □ wallet  □ signing
 next · wallet: open the page, make a key, sign with your wallet
 [ close tunnel ]  [ open page to sign ]
```

Every square is a **check first**. Pressing **re-check** reads the real state of your account and your server and changes nothing; a fix only runs for a square that is not green. Run it again after a failure, a reboot or a week away, and it picks up where things actually stand.

## Nobody else holds your keys

Everything runs on your computer:

- **Your DigitalOcean token** is held by [doctl](https://docs.digitalocean.com/reference/doctl/), DigitalOcean's own command-line tool, in its settings on your computer. This mod never stores it, reads it back or sends it anywhere: it only runs doctl.
- **The SSH key** is made on your computer for this mod and kept in its folder (or you name your own in the mod's settings). Its public half goes to your DigitalOcean account; the private half never leaves your machine.
- **Your wallet** signs in your own browser, on the validator's own page, reached through an SSH tunnel to your server.
- **Nothing on the server reports anywhere.** The pane reads the server's state over your own SSH connection when you look.

There is no service in the middle, no account to create, and no one to trust but DigitalOcean and 6529.

## Install

At the prompt of a Claude Code session in a terminal:

```
/plugin install 6529-validator-mod --marketplace eduardocruz/marketplace
```

From a shell:

```
claude plugin install 6529-validator-mod --marketplace eduardocruz/marketplace
```

Answer `y` to add the marketplace and choose a scope. Then type `/validator`.

The first square is **doctl**. If you don't have it, press **install doctl**: the mod downloads DigitalOcean's release for your computer from GitHub, checks it against the release's SHA-256 list, and keeps it in the mod's own folder (no package manager, no admin password). Then sign in by pasting a token from [cloud.digitalocean.com/account/api/tokens](https://cloud.digitalocean.com/account/api/tokens) into the pane, or press **copy sign-in command** and run it in a terminal. If you already use doctl and are signed in, the square is green from the start.

Optional: a token with custom scopes limited to what this needs (droplets, SSH keys, regions and sizes) limits what anyone could do with it.

## What the squares mean

| Square | Green when | What fixes it |
| --- | --- | --- |
| doctl | doctl is installed and signed in to your account | **install doctl**, then paste a token or **copy sign-in command** |
| ssh key | the mod's key is on your DigitalOcean account | **add my key to DigitalOcean** (makes the key the first time) |
| server | the droplet is active with an address | **+ new server**: pick a region and a size, then **create server** |
| ssh | the server answers on the key | waits while the server boots; goes red at once if the server refuses the key |
| setup | the install script finished | runs by itself on first boot, about 5 minutes |
| firewall | only 22 and 4001 (TCP and QUIC) are open | set by the install script |
| package | the validator is installed and its checksum matched 6529's `SHA256SUMS` | set by the install script; shows when an update is out |
| mode | the validator runs in data-center mode (no Tor, makes blocks) | set by the install script |
| service | the validator's service is running | |
| tunnel | the validator's page answers on `127.0.0.1:16529` here | **open tunnel** |
| wallet | your validator key is authorized by your wallet | **open page to sign**, then follow the page |
| signing | the validator signed today | waits for the day's window |

A red square gets a **diagnose with Claude** button. It hands Claude what the squares and the setup log say and asks for the cause and the fix, without changing anything on the server until you agree.

## Sizes and cost

The server is on your DigitalOcean account and its bill is DigitalOcean's. Destroying the droplet stops the bill.

- **8 GB / 4 vCPU** (about US$48 a month): what 6529's cloud guide recommends. The default.
- **4 GB / 2 vCPU** (about US$24 a month): finished an initial sync in a test, but sits below 6529's guidance.

Prices are read live from DigitalOcean when the pane opens.

## What runs on the server

One file, [`cloud-init/validator.yaml`](cloud-init/validator.yaml), sent unchanged as the droplet's user data. Read it before you create a server. It:

1. turns off password login (your key is added by DigitalOcean);
2. enables a firewall with only SSH (22) and the validator's peer port (4001, TCP and UDP) open;
3. downloads the newest validator `.deb` named on 6529.io/validator, checks it against 6529's `SHA256SUMS`, and installs it;
4. switches the validator to data-center mode with its page bound to `127.0.0.1:16529`, and starts it.

It never touches a wallet and sends nothing anywhere.

## Requirements

- Claude Code in a terminal (the pane uses Claude Code's mods).
- macOS or Linux, with `ssh`, `ssh-keygen`, `curl` and `tar` (all come with the system). Windows is not supported yet.
- A DigitalOcean account with a payment method.

## Status

0.1.0, a first release. Tested end to end on a fresh DigitalOcean server (fra1, 8 GB): every square from server to service turned green in about three minutes, and the validator's page opened through the tunnel. The wallet and signing steps need a real holder's wallet and were not part of that run. Report what breaks in the issues.

Unofficial: not made or endorsed by 6529.

## License

MIT
