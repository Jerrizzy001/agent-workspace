# Agent Workspace browser host

Run Agent Workspace on a Mac or Linux computer and control its projects from a phone or another computer. The browser controls this host's files, terminals, and installed coding agent CLIs. This is a single-owner alpha; pairing grants the host account's workspace control.

## Install and start

Install Node.js 24 or newer, Git, and tmux using your operating system's package manager. Install and authenticate any Claude or Codex CLI you want to use on this host. Extract this archive into its own folder, then run:

```sh
npm ci
npm start -- --data-dir /absolute/path/to/workspace-data --project /absolute/path/to/your/git-project --host 127.0.0.1 --port 8787
```

The server defaults to a loopback listener. Its start message prints the address and the path to an owner-only pairing file, never the pairing code. Open that file locally when you are ready to pair your browser. Keep the code private. Browser authentication expires after 12 hours or when the server restarts. Restarting also disconnects all clients. Delete or replace the owner-only pairing file while the server is stopped to rotate its code.

`--project` is repeatable. The server registers only the projects the host owner supplies, and browsers cannot register arbitrary filesystem paths. On later starts the data directory remembers registered projects. Use a dedicated data directory; do not point a running desktop and headless host at the same data directory. The owner lock rejects concurrent cores.

Node's native terminal dependency is installed on the destination host. This distribution contains no Electron files or Electron rebuild hooks. If the host lacks a compatible node-pty prebuild, npm needs the host's C++ build tools. Run `npm run rebuild` after changing Node versions or moving a previously installed folder between operating systems or architectures. Do not copy node_modules from an Electron installation.

## Connect through HTTPS

For access beyond the host, use your own authenticated network and HTTPS proxy. A [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) or comparable HTTPS reverse proxy can forward to the loopback service. Follow its official setup guide; Tailscale requires login authorization and HTTPS enabled for the tailnet. Set the precise HTTPS origin the browser will open:

```sh
npm start -- --data-dir /absolute/path/to/workspace-data --project /absolute/path/to/your/git-project --host 127.0.0.1 --port 8787 --public-origin https://your-host.your-tailnet.ts.net
```

Configure your proxy to preserve the public Host and Origin headers and forward WebSocket upgrades. The browser address must use the exact origin supplied, without a path prefix. Keep access within your private network. This package does not install Tailscale, create DNS records, configure firewalls, or publish a public endpoint.

For direct private-network HTTPS, supply a browser-trusted certificate and matching key, a listener address, and the exact browser origin:

```sh
npm start -- --data-dir /absolute/path/to/workspace-data --project /absolute/path/to/your/git-project --host 0.0.0.0 --port 8787 --tls-cert /absolute/path/to/certificate.pem --tls-key /absolute/path/to/private-key.pem --public-origin https://your-private-host:8787
```

The host name must match the certificate and resolve from your other device. Unencrypted non-loopback listeners are rejected. A self-signed certificate needs a deliberate trust setup on each device; use a trusted certificate for everyday use.

Open the HTTPS address in your phone's browser, enter the pairing code, and connect. The browser's install or Add to Home Screen action can make a separate app shortcut. Installation availability varies by browser. The open app shows connection status and reconnects when the host returns. A fresh offline launch is not supported.

## Keep work running

Keep the host awake and the server process running under a process supervisor you manage if you need unattended browser availability. A phone can close or lose its connection while the terminal process continues in tmux. Reconnecting and selecting the attempt reattaches to the same session. Stopping the server with Ctrl+C detaches views and closes the core, while its tmux processes remain available when the same data directory reopens. An explicit Terminate action stops the selected session. A reboot ends live processes.

The built-in shell, files, Git, tasks, notes, worktrees, and agent CLI controls share the same host core. These provider terminals do not implement provider-specific structured approvals, usage accounting, or conversation resume. The host account retains its normal privileges.

Run `npm start -- --help` for all CLI options. Environment alternatives are `DATA_DIR`, `HOST`, `PORT`, `TLS_CERT`, `TLS_KEY`, `PUBLIC_ORIGIN`, and `STATIC_DIR`. Serve this bundled `dist/renderer` directory; its assets work outside the original source checkout.
