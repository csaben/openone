#!/usr/bin/env node
// openone-ask: put a question with buttons on your phone from any script, and print the
// answer. For things that aren't agents (Hermes, cron jobs, index-ram).
//
//   node src/ask-cli.js "Add Dentist Thu 3pm?" -o Add -o Skip [-b "detail"] [--from hermes]
//        [--default Skip] [--ttl 3600] [--wait 600] [--no-wait] [--tag calendar:123]
//
// Prints the chosen option's label and exits 0. Exits 2 if it expired or the wait ran out
// (then prints the ask id; GET /api/asks/<id> later), 1 on errors.
//   OPENONE_URL  the openone server (default http://127.0.0.1:8950)

const URL_ = (process.env.OPENONE_URL || 'http://127.0.0.1:8950').replace(/\/$/, '');

function parse(argv) {
  const o = { options: [], wait: 600 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '-o' || a === '--option') o.options.push(next());
    else if (a === '-b' || a === '--body') o.body = next();
    else if (a === '--from') o.from = next();
    else if (a === '--default') o.default = next();
    else if (a === '--ttl') o.ttlSec = Number(next());
    else if (a === '--wait') o.wait = Number(next());
    else if (a === '--no-wait') o.wait = 0;
    else if (a === '--tag') o.tag = next();
    else if (a === '--project') o.project = next();
    else if (a.startsWith('-')) throw new Error(`unknown flag ${a}`);
    else if (!o.title) o.title = a;
    else throw new Error(`unexpected "${a}"`);
  }
  if (!o.title) throw new Error('usage: ask-cli.js "question" -o Yes -o No');
  return o;
}

async function req(method, rest, body) {
  const r = await fetch(`${URL_}/api/asks${rest}`, body ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { method });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

(async () => {
  const { wait, ...o } = parse(process.argv.slice(2));
  let a = await req('POST', '', { from: o.from || 'script', ...o });
  const until = Date.now() + wait * 1000;
  while (a.status === 'pending' && Date.now() < until) {
    a = await req('GET', `/${a.id}?wait=${Math.max(1, Math.min(55, Math.ceil((until - Date.now()) / 1000)))}`);
  }
  if (a.status === 'answered') { console.log(a.answerLabel); process.exit(0); }
  console.log(a.id);
  process.exit(2);
})().catch((e) => { console.error(`openone-ask: ${e.message}`); process.exit(1); });
