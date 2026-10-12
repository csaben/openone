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

**Ctrl+Alt+Space** opens the panel. In the panel, **Enter** jumps to the pane, **Tab** moves to the next item and **Esc** closes it. The tray menu has mute, start at login and config.

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

## Notes

- Agent state comes from reading the screen. "esc to interrupt" means working, and a numbered menu with a cursor means waiting on you. `npm test` runs against real captured Claude Code screens.
- psmux pane ids repeat across sessions, so openone always targets `session:window.%id`.
- `npx electron tools/render-icons.js` rebuilds the PNG icons from `assets/*.svg`.
