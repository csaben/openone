// The push-to-talk microphone (a hidden window): records between start and stop and
// hands the audio (webm/opus) back to the main process. The mic is opened per recording,
// so Windows only shows it in use while you talk. A short tone says it's listening.

let rec = null;
let chunks = [];
let stream = null;
let ctx = null;
let meter = null;
let opening = false; // waiting on the mic
let stopEarly = false; // let go before it opened

function tone(freq, ms) {
  try {
    ctx = ctx || new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ms / 1000);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + ms / 1000 + 0.02);
  } catch {}
}

window.ooRec.onStart(async ({ beep, mic }) => {
  if (rec || opening) return;
  opening = true;
  stopEarly = false;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: mic ? { deviceId: mic } : { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    opening = false;
    window.ooRec.error(`Couldn't open the microphone: ${e.message}`);
    return;
  }
  opening = false;
  if (stopEarly) {
    for (const t of stream.getTracks()) t.stop();
    stream = null;
    window.ooRec.data(new ArrayBuffer(0));
    return;
  }
  chunks = [];
  rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    const blob = new Blob(chunks, { type: 'audio/webm' });
    for (const t of stream.getTracks()) t.stop();
    stream = null;
    rec = null;
    window.ooRec.data(await blob.arrayBuffer());
  };
  rec.start(250);
  if (beep) tone(880, 90);
  // how loud, ~12 times a second, for the indicator
  try {
    ctx = ctx || new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    meter = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const x of buf) sum += x * x;
      window.ooRec.level(Math.sqrt(sum / buf.length));
    }, 80);
  } catch {}
  window.ooRec.started();
});

window.ooRec.onStop(({ beep }) => {
  if (opening) { stopEarly = true; return; }
  if (!rec) return;
  if (beep) tone(560, 90);
  clearInterval(meter);
  rec.stop();
});

// ---------- playing what agents say ----------
let playing = null;
window.ooRec.onPlay(({ id, audio, mime, speed }) => {
  if (playing) { playing.el.pause(); URL.revokeObjectURL(playing.url); }
  const url = URL.createObjectURL(new Blob([audio], { type: mime || 'audio/mpeg' }));
  const el = new Audio(url);
  el.playbackRate = speed || 1; // pitch is kept, only faster
  el.preservesPitch = true;
  playing = { id, el, url };
  const end = (err) => {
    if (!playing || playing.id !== id) return;
    URL.revokeObjectURL(url);
    playing = null;
    window.ooRec.played(id, err);
  };
  el.onended = () => end();
  el.onerror = () => end('could not play it');
  el.play().catch((e) => end(e.message));
});
window.ooRec.onPlayStop(() => {
  if (!playing) return;
  playing.el.pause();
  URL.revokeObjectURL(playing.url);
  window.ooRec.played(playing.id, 'stopped');
  playing = null;
});
