// Browser stand-in for the Electron preload: implements window.oo over the server's
// HTTP API and event stream, plus the bits a browser needs that the desktop doesn't:
// a pane screen viewer (instead of jumping to a terminal) and a "new session" form.
(() => {
  document.body.classList.add('web');
  const handlers = {};
  const fire = (ch, data) => (handlers[ch] || []).forEach((fn) => fn(data));
  const enc = encodeURIComponent;
  const store = {
    get: (k, d) => { try { const v = localStorage.getItem(`oo.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(`oo.${k}`, JSON.stringify(v)); } catch {} },
  };
  let showShells = store.get('shells', false);
  let muted = store.get('muted', false);
  let last = { panes: [], hosts: [] };

  async function call(method, url, body) {
    const res = await fetch(url, {
      method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function emitState() {
    fire('state', {
      panes: last.panes.filter((p) => showShells || p.state !== 'shell'),
      hosts: last.hosts, showShells, muted,
    });
  }

  function toast(msg) { fire('toast', msg); }

  function connect() {
    const es = new EventSource('api/events');
    es.addEventListener('state', (e) => { last = JSON.parse(e.data); emitState(); });
    es.addEventListener('peek', (e) => {
      const ev = JSON.parse(e.data);
      const p = last.panes.find((x) => x.key === ev.key);
      if (!p || muted || !('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
      const n = new Notification(`${p.kind || 'agent'} · ${p.label} ${ev.type === 'input' ? 'needs you' : 'finished'}`, {
        body: ev.type === 'input' ? (p.question || 'Waiting for your answer') : (p.summary || '').slice(0, 160),
        icon: 'assets/app-256.png', tag: p.key,
      });
      n.onclick = () => { window.focus(); viewer(p.key); };
    });
    es.addEventListener('reload', () => location.reload());
    es.onerror = () => {}; // EventSource reconnects by itself
  }

  // ---------- screen viewer ----------

  const sheet = document.createElement('div');
  sheet.id = 'sheet';
  sheet.className = 'hit';
  document.body.appendChild(sheet);
  let viewing = null;
  let timer = null;
  let raw = '';
  // Terminals are ~200 columns; a phone shows ~45 at a readable size. So on narrow
  // screens wrap lines by default, and let font size be set with A-/A+ or a pinch.
  const narrow = window.matchMedia('(max-width: 700px)').matches;
  let wrap = store.get('wrap', narrow);
  let fontPx = store.get('fontPx', narrow ? 10.5 : 12);

  function closeSheet() {
    sheet.classList.remove('show');
    viewing = null;
    clearInterval(timer);
  }

  // Terminal padding is noise when wrapped: trailing spaces, huge gaps, full-width rules.
  function tidy(text) {
    let lines = text.replace(/\s+$/, '').split('\n').map((l) => l.replace(/\s+$/, ''));
    if (wrap) lines = lines.map((l) => l.replace(/([─━═╌]{24})[─━═╌]+/g, '$1').replace(/(\S) {6,}(?=\S)/g, '$1   '));
    return lines.join('\n');
  }

  function applyView() {
    const pre = sheet.querySelector('pre');
    if (!pre) return;
    pre.classList.toggle('wrap', wrap);
    pre.style.fontSize = `${fontPx}px`;
    const w = sheet.querySelector('[data-wrap]');
    if (w) w.classList.toggle('on', wrap);
  }

  function render(stick) {
    const pre = sheet.querySelector('pre');
    if (!pre) return;
    const atBottom = stick || pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
    pre.textContent = tidy(raw);
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  }

  async function refresh() {
    if (!viewing) return;
    try {
      raw = (await call('GET', `api/panes/${enc(viewing)}/screen?lines=300`)).text;
      render();
    } catch (e) { sheet.querySelector('pre').textContent = `(${e.message})`; }
  }

  function setFont(px) {
    fontPx = Math.max(6, Math.min(22, Math.round(px * 2) / 2));
    store.set('fontPx', fontPx);
    applyView();
  }

  function viewer(key) {
    const p = last.panes.find((x) => x.key === key);
    const name = p ? `${p.kind || 'shell'} · ${p.label}` : key.split('|').slice(1).join(' ');
    viewing = key;
    raw = '';
    sheet.innerHTML = `
      <div class="bar"><b></b><span class="sp"></span>
        <button data-zoom="-1" title="Smaller text">A−</button><button data-zoom="1" title="Larger text">A+</button>
        <button data-wrap title="Wrap long lines">wrap</button>
        <button data-k="Escape" title="Esc">esc</button><button data-k="C-c" title="Ctrl+C">^C</button>
        <button data-focus title="Select this pane in its tmux session">focus</button>
        <button data-close title="Close">✕</button></div>
      <pre></pre>
      <form class="send"><input placeholder="Type into this pane…  (Enter sends)" spellcheck="false" autocomplete="off"><button>↵</button></form>`;
    sheet.querySelector('b').textContent = name;
    sheet.classList.add('show');
    applyView();
    pinch(sheet.querySelector('pre'));
    call('POST', `api/panes/${enc(key)}/seen`).catch(() => {});
    refresh();
    clearInterval(timer);
    timer = setInterval(refresh, 1500);
  }

  // two-finger pinch on the pane text scales its font instead of the page
  function pinch(pre) {
    let start = 0;
    let base = fontPx;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    pre.addEventListener('touchstart', (e) => { if (e.touches.length === 2) { start = dist(e.touches); base = fontPx; } }, { passive: true });
    pre.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 2 || !start) return;
      e.preventDefault();
      setFont(base * (dist(e.touches) / start));
    }, { passive: false });
    pre.addEventListener('touchend', () => { start = 0; });
  }

  sheet.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t || !viewing) return;
    if (t.dataset.close !== undefined) return closeSheet();
    if (t.dataset.zoom) return setFont(fontPx + Number(t.dataset.zoom));
    if (t.dataset.wrap !== undefined) { wrap = !wrap; store.set('wrap', wrap); applyView(); return render(true); }
    try {
      if (t.dataset.k) await call('POST', `api/panes/${enc(viewing)}/keys`, { keys: [t.dataset.k] });
      else if (t.dataset.focus !== undefined) { await call('POST', `api/panes/${enc(viewing)}/focus`); toast('Selected in tmux'); }
      setTimeout(refresh, 300);
    } catch (err) { toast(err.message); }
  });

  sheet.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = sheet.querySelector('.send input');
    const text = input.value;
    if (!text || !viewing) return;
    input.value = '';
    try {
      await call('POST', `api/panes/${enc(viewing)}/text`, { text });
      await call('POST', `api/panes/${enc(viewing)}/keys`, { keys: ['Enter'] });
      setTimeout(refresh, 400);
    } catch (err) { toast(err.message); }
  });

  // ---------- menu and new session ----------

  const menu = document.createElement('div');
  menu.id = 'webmenu';
  menu.className = 'hit';
  document.body.appendChild(menu);

  function openMenu() {
    const notif = !('Notification' in window) ? '' : Notification.permission === 'granted'
      ? `<button data-a="mute">${muted ? 'Unmute' : 'Mute'} notifications</button>`
      : '<button data-a="notify">Enable notifications</button>';
    menu.innerHTML = `<button data-a="new">New session…</button>
      <button data-a="shells">${showShells ? 'Hide' : 'Show'} shells</button>${notif}`;
    menu.classList.toggle('show');
  }

  menu.addEventListener('click', async (e) => {
    const a = e.target.closest('button') && e.target.closest('button').dataset.a;
    if (!a) return;
    menu.classList.remove('show');
    if (a === 'shells') { showShells = !showShells; store.set('shells', showShells); emitState(); }
    if (a === 'mute') { muted = !muted; store.set('muted', muted); emitState(); }
    if (a === 'notify') Notification.requestPermission();
    if (a === 'new') newSession();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#webmenu') && !e.target.closest('#b-more')) menu.classList.remove('show');
  });

  function newSession() {
    const hostOpts = last.hosts.map((h) => `<option${h.ok ? '' : ' disabled'}>${h.name}</option>`).join('');
    sheet.innerHTML = `
      <div class="bar"><b>New session</b><span class="sp"></span><button data-close>✕</button></div>
      <form class="new">
        <label>Host<select name="host">${hostOpts}</select></label>
        <label>Session name<input name="name" placeholder="exp1" pattern="[A-Za-z0-9_.-]{1,40}" required></label>
        <label>Working directory<input name="cwd" placeholder="~/Code/project  (blank: home)"></label>
        <label>Command<input name="cmd" placeholder="claude   (blank: just a shell)"></label>
        <button class="go">Start</button>
      </form>`;
    viewing = null;
    sheet.classList.add('show');
    sheet.querySelector('form.new').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        const r = await call('POST', `api/hosts/${enc(f.get('host'))}/sessions`, { name: f.get('name'), cwd: f.get('cwd'), cmd: f.get('cmd') });
        viewer(r.key);
      } catch (err) { toast(err.message); }
    });
  }

  // ---------- window.oo ----------

  window.oo = {
    on: (ch, fn) => { (handlers[ch] = handlers[ch] || []).push(fn); },
    ignore: () => {}, size: () => {}, focus: () => {},
    menu: openMenu,
    mute: () => { muted = !muted; store.set('muted', muted); emitState(); },
    ready: () => { connect(); fire('expand'); },
    jump: (key) => viewer(key),
    answer: (key, n) => call('POST', `api/panes/${enc(key)}/answer`, { n }).catch((e) => toast(e.message)),
    reply: (key, text) => call('POST', `api/panes/${enc(key)}/reply`, { text }).catch((e) => toast(e.message)),
    seen: (key) => call('POST', `api/panes/${enc(key)}/seen`).catch(() => {}),
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheet.classList.contains('show') && e.target.tagName !== 'INPUT') closeSheet();
  });
  const term = document.getElementById('b-term');
  if (term) term.title = 'Show pane';
})();
