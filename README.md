<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/spiky-cloud-white-small.svg">
    <img src="assets/spiky-cloud-black.svg" width="160" alt="openone">
  </picture>
</p>

# openone

A small Windows edge dock that watches the coding agents (Claude Code, Codex) running in your tmux panes and tells you when one needs you.

It's inspired by [One](https://getone.one/#what-it-is). I loved the side-screen UI and having every agent in one place. But I didn't want a new terminal or a new way of working: I already run psmux in one Windows Terminal tab and ssh + tmux to a Linux box in another. openone just watches those panes and gets out of the way.

- **Edge tab**: one dot per active agent. Blue means working, amber means it needs your answer, green means finished.
- **Inbox card**: shows the question or the command waiting for approval. Press `1`–`9` to answer, or type a reply.
- **Toasts and a peek bubble** when an agent finishes or asks something. None for the pane you're already looking at.
- **Click an agent** to select that pane in its real tmux session, switch Windows Terminal to the right tab and bring it forward.

Nothing is installed on the remote machine. openone reads panes with `tmux capture-pane` over one persistent ssh connection, and with `psmux` locally.

## Setup

Needs Node 18+, [just](https://github.com/casey/just), Windows Terminal, [psmux](https://github.com/marlocarlo/psmux) (`winget install marlocarlo.psmux`) for local panes, and ssh key auth to any remote hosts.

```powershell
git clone https://github.com/csaben/openone
cd openone
just install        # or: npm install; npm run dist; then run dist\openone-setup-*.exe
```

That builds a one-click, per-user installer, installs openone, launches it and makes it start at login. Other recipes: `just dev` (run from source), `just push-config`, `just uninstall`. Plain `npm install` + `.\start-openone.cmd` also runs it straight from the checkout.

On first run it writes `config.json` (to `%APPDATA%\openone` for an installed copy). psmux is turned on if it's installed, and every host in `~/.ssh/config` is added but turned off. Set `"enabled": true` on the ones you want, make each `wtTab` regex match that host's Windows Terminal tab title, then choose **Reload config** from the tray. See `config.example.json` for the shape.

**Ctrl+Alt+Space** opens the panel on the agent list, with the most urgent agent selected. **j**/**k** (or the arrow keys) move, **Enter** jumps to the pane, **Tab** switches to the inbox of waiting and finished agents, **r** replies, **1**–**9** answer a question and **Esc** closes. **/** searches agents by name, host or words from their conversation; arrows or Ctrl+j/k pick a match and **Enter** jumps to it. Set `hotkey` in the config to change the shortcut. The tray menu has mute, start at login and config.

### Projects

**n** in the panel starts or continues work in a project folder. Type what you're working on: it matches the folders in each host's `workspace`, or offers a new folder named after what you typed. Add a host name ("drive backup cradle") to pick where it goes. Then choose claude or codex and whether to continue the last chat, and **Enter** opens a new window in the tmux session that host's terminal tab shows, `cd`s into the folder (creating it if new) and starts the agent. **o** opens the folder in VS Code, over Remote-SSH for ssh hosts; **o** on a row of the agent list opens that pane's folder.

Before offering a new folder, the picker checks every host for work that already covers it: agents whose title or output match, and project folders whose name or README match, by words and by meaning. Meaning comes from a small embedding model (all-MiniLM-L6-v2, 8-bit ONNX, 23 MB) run on the CPU through WebAssembly in a worker thread; it downloads on first use, each README summary is embedded once and cached, and a search takes a few milliseconds. `"semantic": false` turns it off.

Per host, `workspace` is the folder that holds your projects (default `~/Code`), and `vscode` the Remote-SSH host name if it differs from `ssh`. The agent commands can be changed with a top-level `agents`, e.g. `{ "claude": { "start": "claude", "resume": "claude --continue" }, "codex": { "start": "codex", "resume": "codex resume --last" } }`.

## Server (web and phone, experimental)

`server/` runs the same watcher on an always-on Linux box. It reaches every machine over ssh, serves the same panel as a web page, and exposes an HTTP API to answer agents and start new sessions. It keeps no state of its own; tmux on each machine is the source of truth.

```bash
cp server/config.example.json server/config.json    # list your hosts
node server/index.js                                # listens on 127.0.0.1:8950
tailscale serve --bg --https=8951 http://127.0.0.1:8950
```

Host types: `tmux` (the server machine itself), `ssh` (remote tmux) and `ssh-psmux` (remote Windows; give the full path to `psmux.exe`). It is reachable only through `tailscale serve`. Set `allow` to a list of tailnet logins to restrict it further. Anyone who can reach it can type into your shells, so never expose it publicly.

| | |
| --- | --- |
| `GET /api/state` | hosts and every pane with its agent state |
| `GET /api/events` | server-sent events: `state` on change, `peek` when an agent finishes or needs you |
| `GET /api/panes/:key/screen` | current screen text |
| `POST /api/panes/:key/answer` `{n}` · `/reply` `{text}` · `/text` `{text}` · `/keys` `{keys}` · `/focus` · `/seen` | drive a pane |
| `POST /api/hosts/:host/sessions` `{name, cwd, cmd}` | start a detached session and type `cmd` into it |
| `DELETE /api/hosts/:host/sessions/:name` | kill a session |
| `/api/bus/…` `roster` · `send` · `peek` · `projects` · `ls` · `start` · `listen` · `messages` | the agent tools below |

### Agents talking to each other

`src/mcp.js` is an MCP server (Node, no dependencies) that gives Claude Code and Codex these tools, backed by the openone server:

| | |
| --- | --- |
| `roster` | every agent on every host: name (`label@host`), state, title, last turn's summary, and which one is you |
| `send {to, content}` | message another agent |
| `peek {name, lines}` | read another agent's screen |
| `projects {host}` · `ls {host, path}` | the folders in each host's workspace, and what's inside them |
| `start {host, folder, agent, prompt, create, resume}` | start a new agent in a project, with a first message signed by the caller |

A message is typed into the target's chat as `[openone message from <name> …] <text>` once the target is idle, so it never interrupts a turn or a menu waiting for you. A Claude session started with `--dangerously-load-development-channels server:openone` gets it pushed right away as a channel event instead. The panel shows each agent's latest message on its row. A reply chain stops after 6 hops between agents until you step in (answering, replying or opening the agent resets it), and an agent can send 30 messages per 10 minutes.

The tool finds its own pane from `$TMUX_PANE`, so messages carry a sender. Register it on each machine, pointing at the server:

```bash
claude mcp add -s user openone -e OPENONE_URL=https://<server>:8951 -- node /path/to/openone/src/mcp.js
```

```toml
# ~/.codex/config.toml
[mcp_servers.openone]
command = "node"
args = ["/path/to/openone/src/mcp.js"]
env = { OPENONE_URL = "https://<server>:8951" }
env_vars = ["TMUX", "TMUX_PANE", "PSMUX_SESSION"]
```

`OPENONE_HOST` overrides the host name the tool reports (default: the machine's hostname, which should match the host's `name` in the server config). On the desktop app, `"server": "https://<server>:8951"` in the config shows the messages in the panel.

A message typed into a pane reads like a prompt from you, so any agent can steer any other. The tool tells agents to treat these as requests from a sibling, not from you, and every message is logged, but only use this between agents you'd let act on each other's behalf.

## Notes

- Agent state comes from reading the screen. A spinner line above the input box (or "esc to interrupt") means working, and a numbered menu with a cursor means waiting on you. `npm test` runs against real captured Claude Code screens.
- On psmux, panes are streamed rather than polled: one control-mode client per session (`psmux -C attach`) feeds each pane's output into a headless terminal emulator, because every `capture-pane` can flash the attached terminal. Each pane is read once when openone first sees it. Set `"stream": false` on a host to go back to polling.
- psmux pane ids repeat across sessions, so openone always targets `session:window.%id`.
- `npx electron tools/render-icons.js` rebuilds the PNG icons from `assets/*.svg`.
