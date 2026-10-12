// First run: build a config.json from what this machine already has.
// The local psmux host is enabled if psmux is installed; every concrete Host in
// ~/.ssh/config is added disabled, so nothing is polled until you opt in.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function parseSshConfig(text) {
  const hosts = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^(\w+)\s*=?\s*(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'host' || key === 'match') {
      cur = null;
      if (key === 'host') {
        for (const alias of m[2].split(/\s+/)) {
          if (/[*?!]/.test(alias)) continue;
          cur = cur || [];
          const h = { alias, hostname: '', user: '' };
          cur.push(h);
          hosts.push(h);
        }
      }
    } else if (cur && (key === 'hostname' || key === 'user')) {
      for (const h of cur) h[key] = m[2].trim();
    }
  }
  return hosts;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function defaultConfig({ hostname, hasPsmux, sshHosts }) {
  const hosts = [];
  if (hasPsmux) {
    hosts.push({ name: hostname.toLowerCase(), type: 'psmux', pollMs: 1500, wtTab: 'PowerShell|pwsh|psmux|tmux', wtTabIndex: 0 });
  }
  for (const h of sshHosts) {
    const tab = [escape(h.alias), h.user && `${escape(h.user)}@`].filter(Boolean).join('|');
    hosts.push({ name: h.alias, type: 'ssh', ssh: h.alias, pollMs: 1500, wtTab: tab, enabled: false });
  }
  return {
    hosts,
    hotkey: 'Control+Alt+Space',
    notify: { input: true, done: true, toast: true, sound: true },
    showShells: false,
    display: 'primary',
  };
}

function detect() {
  let hasPsmux = false;
  try { execFileSync('where', ['psmux'], { stdio: 'ignore', windowsHide: true }); hasPsmux = true; } catch {}
  let sshHosts = [];
  try { sshHosts = parseSshConfig(fs.readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8')); } catch {}
  return defaultConfig({ hostname: os.hostname(), hasPsmux, sshHosts });
}

module.exports = { parseSshConfig, defaultConfig, detect };
