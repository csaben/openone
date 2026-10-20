// The push-to-talk indicator at the bottom of the screen: opening the mic, listening
// (with the mic level, so you can see it hears you), transcribing, then what was sent
// where, or what went wrong.
const pill = document.getElementById('pill');
const bars = document.getElementById('bars');
const text = document.getElementById('text');
const N = 14;
for (let i = 0; i < N; i++) bars.appendChild(document.createElement('i'));
const levels = new Array(N).fill(0);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

window.ooPill.onState(({ mode, title, detail }) => {
  pill.className = `show ${mode}`;
  text.innerHTML = `${esc(title)}${detail ? ` <small>${esc(detail)}</small>` : ''}`;
  if (mode !== 'rec') levels.fill(0);
});

window.ooPill.onLevel((v) => {
  levels.shift();
  levels.push(Math.min(1, v * 6));
  bars.querySelectorAll('i').forEach((b, i) => { b.style.height = `${3 + Math.round(levels[i] * 15)}px`; });
});
