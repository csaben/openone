// Node side of wt-focus.ps1: one PowerShell kept warm so tab switches are instant.

const { spawn } = require('child_process');
const path = require('path');

class WindowsTerminal {
  constructor() {
    this.proc = null;
    this.buf = '';
    this.queue = [];
  }

  start() {
    if (this.proc) return;
    const script = path.join(__dirname, 'wt-focus.ps1').replace('app.asar', 'app.asar.unpacked');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true });
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        const w = this.queue.shift();
        if (!w) continue;
        try { w.resolve(JSON.parse(line)); } catch { w.resolve({ ok: false, error: line }); }
      }
    });
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null;
      for (const w of this.queue.splice(0)) w.resolve({ ok: false, error: 'helper exited' });
    });
  }

  request(obj, timeoutMs = 5000) {
    this.start();
    return new Promise((resolve) => {
      const w = { resolve };
      const timer = setTimeout(() => {
        const i = this.queue.indexOf(w);
        if (i >= 0) this.queue.splice(i, 1);
        resolve({ ok: false, error: 'timeout' });
      }, timeoutMs);
      w.resolve = (v) => { clearTimeout(timer); resolve(v); };
      this.queue.push(w);
      this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
    });
  }

  tabs() { return this.request({ op: 'tabs' }); }

  focus(tab, index) { return this.request({ op: 'focus', tab, index }); }

  stop() { if (this.proc) this.proc.kill(); }
}

module.exports = { WindowsTerminal };
