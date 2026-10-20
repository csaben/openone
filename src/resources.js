// What's using the machines: memory and CPU per pane (everything a pane started, added
// up through its process tree), and the biggest things running outside any pane.
//
// Each source runs one script on its host (PowerShell on Windows, sh on Linux) that prints
//   @@MEM <total bytes> <available bytes>
//   <pid>\t<ppid>\t<resident bytes>\t<cpu seconds so far>\t<name>\t<service or ''>\t<command line>
//   @@GPU                      (Linux with nvidia-smi only)
//   <pid>, <MiB>
// Two samples a moment apart give CPU in use now.

const SH = [
  "awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{print \"@@MEM\", t*1024, a*1024}' /proc/meminfo",
  // times = cpu seconds; comm can hold spaces, so the name comes from args. The group is the
  // systemd (user) service, so "python" processes read as the model server, the API, ...
  "ps -eo pid=,ppid=,rss=,times=,uunit=,unit=,args= | awk '{pid=$1; ppid=$2; rss=$3*1024; t=$4; g=$5; if (g == \"-\" || g ~ /^(app-|session-|user@|init[.]scope|tmux-spawn-)/) g=$6; " +
    "if (g ~ /^docker-/) g=\"docker\"; if (g == \"-\" || g ~ /^(app-|session-|user@|init[.]scope|tmux-spawn-)/) g=\"\"; sub(/[.]service$/, \"\", g); " +
    "$1=$2=$3=$4=$5=$6=\"\"; sub(/^ +/, \"\"); n=$1; sub(/.*\\//, \"\", n); printf \"%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n\", pid, ppid, rss, t, n, g, substr($0, 1, 200)}'",
  'command -v nvidia-smi >/dev/null 2>&1 && { echo @@GPU; nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>/dev/null; }',
  'echo @@END',
].join('; ');

const PS = [
  '$os = Get-CimInstance Win32_OperatingSystem',
  "'@@MEM ' + ([int64]$os.TotalVisibleMemorySize * 1024) + ' ' + ([int64]$os.FreePhysicalMemory * 1024)",
  'Get-CimInstance Win32_Process | ForEach-Object { $c = ([string]$_.CommandLine) -replace "[\\t\\r\\n]", " "; ' +
    'if ($c.Length -gt 200) { $c = $c.Substring(0, 200) }; ' +
    '"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.WorkingSetSize)`t$([math]::Round(($_.KernelModeTime + $_.UserModeTime) / 1e7, 1))`t$($_.Name)`t`t$c" }',
  "'@@END'",
].join('; ');

// "[[dd-]hh:]mm:ss" or plain seconds -> seconds
function seconds(s) {
  const t = String(s || '').trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const [d, rest] = t.includes('-') ? t.split('-') : ['0', t];
  return rest.split(':').map(Number).reduce((a, n) => a * 60 + (n || 0), 0) + Number(d) * 86400;
}

// script output -> { mem: { total, avail }, procs: Map(pid -> proc), gpu: Map(pid -> bytes) }
function parse(out) {
  const mem = { total: 0, avail: 0 };
  const procs = new Map();
  const gpu = new Map();
  let inGpu = false;
  for (const raw of String(out || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('@@MEM')) { const [, t, a] = line.trim().split(/\s+/); mem.total = Number(t) || 0; mem.avail = Number(a) || 0; continue; }
    if (line.startsWith('@@GPU')) { inGpu = true; continue; }
    if (line.startsWith('@@END')) break;
    if (inGpu) {
      const m = line.match(/^\s*(\d+)\s*,\s*(\d+)/);
      if (m) gpu.set(Number(m[1]), (gpu.get(Number(m[1])) || 0) + Number(m[2]) * 1048576);
      continue;
    }
    const v = line.split('\t');
    if (v.length < 5 || !/^\d+$/.test(v[0])) continue;
    procs.set(Number(v[0]), {
      pid: Number(v[0]), ppid: Number(v[1]) || 0, rss: Number(v[2]) || 0, cpu: seconds(v[3]),
      name: String(v[4] || '').replace(/\.exe$/i, ''), group: v[5] || '', cmd: redact(v.slice(6).join('\t')),
    });
  }
  return { mem, procs, gpu };
}

// command lines can carry keys; keep them out of chat
function redact(cmd) {
  return String(cmd || '')
    .replace(/((?:api[-_]?key|token|secret|password|passwd|auth)[\w-]*[=: ]+)("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/\b(sk-[\w-]{6})[\w-]+/g, '$1***');
}

// two samples -> cpu % (of one core) per pid
function cpuRates(a, b, dtSec) {
  const out = new Map();
  for (const [pid, p] of b.procs) {
    const q = a.procs.get(pid);
    out.set(pid, q && dtSec > 0 ? Math.max(0, ((p.cpu - q.cpu) / dtSec) * 100) : 0);
  }
  return out;
}

// pid -> its pid and every descendant's
function tree(procs, root) {
  const kids = new Map();
  for (const p of procs.values()) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p.pid);
  }
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid) || !procs.has(pid)) continue;
    seen.add(pid);
    for (const k of kids.get(pid) || []) if (k !== pid) stack.push(k);
  }
  return seen;
}

// { sample, cpu, panes: [{ key, name, kind, state, since, pid }], now }
// -> { mem, panes: [{ ...pane, rss, cpu, gpu, count, top }], others: [{ name, count, rss, cpu, gpu }] }
function summarize({ sample, cpu = new Map(), panes = [], now = Date.now() }) {
  const { procs, gpu, mem } = sample;
  const owned = new Set();
  const out = [];
  for (const p of panes) {
    if (!p.pid || !procs.has(p.pid)) continue;
    const pids = tree(procs, p.pid);
    const list = [...pids].map((pid) => procs.get(pid));
    for (const pid of pids) owned.add(pid);
    const byName = new Map();
    for (const q of list) {
      const n = byName.get(q.name) || { name: q.name, count: 0, rss: 0 };
      n.count += 1;
      n.rss += q.rss;
      byName.set(q.name, n);
    }
    out.push({
      ...p, count: list.length,
      rss: list.reduce((s, q) => s + q.rss, 0),
      cpu: list.reduce((s, q) => s + (cpu.get(q.pid) || 0), 0),
      gpu: list.reduce((s, q) => s + (gpu.get(q.pid) || 0), 0),
      idleMin: p.state === 'idle' || p.state === 'done' ? Math.round((now - (p.since || now)) / 60000) : 0,
      top: [...byName.values()].sort((x, y) => y.rss - x.rss).slice(0, 4),
    });
  }
  // everything else, grouped by service (Linux) or program name
  const groups = new Map();
  for (const q of procs.values()) {
    if (owned.has(q.pid)) continue;
    const key = q.group || q.name;
    const g = groups.get(key) || { name: key, service: !!q.group, count: 0, rss: 0, cpu: 0, gpu: 0 };
    g.count += 1;
    g.rss += q.rss;
    g.cpu += cpu.get(q.pid) || 0;
    g.gpu += gpu.get(q.pid) || 0;
    groups.set(key, g);
  }
  return {
    mem,
    panes: out.sort((x, y) => y.rss - x.rss),
    others: [...groups.values()].sort((x, y) => y.rss + y.gpu - (x.rss + x.gpu)).slice(0, 10),
  };
}

const gb = (n) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : `${Math.round(n / (1 << 20))} MB`);

module.exports = { SH, PS, parse, cpuRates, tree, summarize, redact, seconds, gb };
