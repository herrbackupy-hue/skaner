// Dashboard online + API do uruchamiania testow na serwerze.
// Uruchomienie:  DASH_TOKEN=sekret PORT=3000 node server.js
//   (bez DASH_TOKEN wygeneruje sie sam i zapisze w .dash-token)
// Dashboard:     http://SERWER:3000/?token=SEKRET   <- otworz w przegladarce
// Wazne: kazdy run wysyla PRAWDZIWE zgloszenia TEST do klubow, wiec przycisk
// "Uruchom" jest za tokenem. Nie udostepniaj URLa z tokenem publicznie.
//
// Na VPS: Node 20+, `npm install`, `npx playwright install chromium`,
//   `npx playwright install-deps chromium` (wymaga roota, jednorazowo),
//   potem np. `npx pm2 start server.js --name checker` albo usluga systemd.
// Harmonogram: wbudowany ?schedule=daily (codziennie 06:00) lub cron systemu:
//   0 6 * * 1 cd /sciezka/form-checker-v2 && HEADLESS_ONLY=1 node check.js --imap >> wyniki/cron.log 2>&1
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CSS, pill, esc, formTitle } = require('./layout');

const DIR = __dirname;
const OUT = path.join(DIR, 'wyniki');
const HIST = path.join(DIR, 'historia');
const STATUS_FILE = path.join(OUT, 'status.json');
const PORT = Number(process.env.PORT || 3000);

let TOKEN = process.env.DASH_TOKEN || '';
const TOKEN_FILE = path.join(DIR, '.dash-token');
if (!TOKEN) {
  try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
  if (!TOKEN) {
    TOKEN = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(TOKEN_FILE, TOKEN);
  }
}
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(HIST, { recursive: true });

const status = () => {
  try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); }
  catch { return { running: false }; }
};
const setStatus = s => fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...status(), ...s }));

function lastResults() {
  try { return JSON.parse(fs.readFileSync(path.join(OUT, 'wynik.json'), 'utf8')); }
  catch { return null; }
}
function history() {
  return fs.readdirSync(HIST).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 30);
}

function startRun({ dry, filter, imap, scheduleNote }) {
  const st = status();
  if (st.running) return { error: 'Test juz trwa (pid ' + st.pid + '). Poczekaj na koniec.' };
  const args = ['check.js'];
  if (dry) args.push('--dry');
  if (filter) args.push('--filter=' + filter);
  if (imap) args.push('--imap');
  const log = fs.openSync(path.join(OUT, 'run.log'), 'w');
  const child = spawn(process.execPath, args, {
    cwd: DIR, stdio: ['ignore', log, log],
    env: { ...process.env, HEADLESS_ONLY: '1' },
    detached: true,
  });
  child.unref();
  setStatus({ running: true, pid: child.pid, startedAt: new Date().toISOString(), args: args.join(' '), note: scheduleNote || '' });
  child.on('exit', () => {
    try {
      const res = lastResults();
      if (res && res.code) {
        fs.copyFileSync(path.join(OUT, 'wynik.json'), path.join(HIST, res.code.replace(/[^A-Z0-9-]/gi, '') + '.json'));
        const files = fs.readdirSync(HIST).filter(f => f.endsWith('.json')).sort();
        while (files.length > 20) fs.unlinkSync(path.join(HIST, files.shift()));
      }
    } catch {}
    setStatus({ running: false, pid: null, finishedAt: new Date().toISOString() });
  });
  return { started: true, pid: child.pid, args: args.join(' ') };
}

function dashboard(token) {
  const last = lastResults();
  const flat = last ? last.results.flatMap(r => (r.forms.length ? r.forms : [null]).map(f => ({ r, f }))) : [];
  const ok = flat.filter(({ f }) => f && f.verdict === 'OK').length;
  const bad = flat.filter(({ f }) => f && f.verdict === 'BLAD').length;
  const rows = last ? last.results.flatMap(r => {
    const siteCell = `<b>${esc(r.name)}</b><br><span class="s">${esc(r.checkedAt || '')}</span>`;
    const urlCell = `<span class="url">${esc(r.url)}</span>`;
    if (!r.forms.length) return [`<tr><td>${siteCell}</td><td>${urlCell}</td><td>${pill(r.verdict)}<br><span class="s">${esc(r.detail)}</span></td></tr>`];
    return r.forms.map(f => `<tr><td>${siteCell}<br><span class="s">${esc(formTitle(f))}</span></td><td>${urlCell}</td><td>${pill(f.verdict)}<br><span class="s">${esc(f.detail || '')}</span></td></tr>`);
  }).join('') : '<tr><td colspan="3">Brak wyników — uruchom pierwszy test.</td></tr>';
  const hist = history().map(f => `<li><a href="/historia/${f}?token=${token}">${f}</a></li>`).join('') || '<li>—</li>';
  return `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kontrola formularzy — panel</title><style>${CSS}
#run{font-weight:650}.spin{display:inline-block;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}</style></head>
<body><div class="top"><h1>Kontrola formularzy — panel</h1>
<div class="meta" id="meta">${last ? `Ostatni test: ${esc(last.code)} • ${esc(last.at)} • ${last.dry ? 'test próbny' : 'realna wysyłka'}` : '—'}</div>
<div class="chips"><span class="chip">Formularzy: <b>${flat.length}</b></span><span class="chip">Działa: <b>${ok}</b></span><span class="chip">Błędów: <b>${bad}</b></span></div></div>
<div class="wrap">
<div class="card" style="padding:12px 14px"><span id="run">…</span>
 <div class="btns">
  <button class="btn" onclick="go(false)">Uruchom test (wysyłka)</button>
  <button class="btn sec" onclick="go(true)">Test próbny (bez wysyłki)</button>
  <a href="/wyniki/raport.html?token=${token}" target="_blank"><button class="btn sec">Pełny raport</button></a>
  <a href="/api/log?token=${token}" target="_blank"><button class="btn sec">Log</button></a>
 </div>
 <div class="s">Test wysyła prawdziwe zgłoszenia TEST do klubów. Harmonogram: SCHEDULE=daily (codziennie 06:00) albo cron systemu (instrukcja w server.js).</div></div>
<div class="card"><table><thead><tr><th style="width:26%">Strona i formularz</th><th style="width:30%">Adres</th><th>Wynik</th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="card" style="padding:12px 14px"><b>Historia testów</b><ul style="margin:8px 0;padding-left:20px">${hist}</ul></div>
</div>
<script>const T="${token}";
async function st(){const r=await fetch("/api/status?token="+T).then(x=>x.json());
document.getElementById("run").innerHTML=r.running?"<span class=spin>◌</span> TEST TRWA (start "+(r.startedAt||"?")+") — odświeżanie co 10 s":"Gotowy do testu.";}
async function go(dry){if(!dry&&!confirm("Wysłać PRAWDZIWE zgłoszenia TEST do klubów?"))return;
const r=await fetch("/api/run?token="+T+(dry?"&dry=1":""),{method:"POST"}).then(x=>x.json());
alert(r.error||("Start! pid "+r.pid));st();}st();setInterval(st,10000);</script></body></html>`;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.log': 'text/plain; charset=utf-8' };
function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8' });
  res.end(body);
}
function safeFile(base, name) {
  const p = path.normalize(path.join(base, name));
  return p.startsWith(base) ? p : null;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const token = u.searchParams.get('token') || '';
  if (token !== TOKEN) return send(res, 403, 'Brak dostepu (zly token).');

  if (u.pathname === '/' && req.method === 'GET') return send(res, 200, dashboard(token), 'text/html; charset=utf-8');
  if (u.pathname === '/api/status') {
    const st = status();
    const last = lastResults();
    return send(res, 200, JSON.stringify({ ...st, lastCode: last && last.code, lastAt: last && last.at }), 'application/json');
  }
  if (u.pathname === '/api/run' && req.method === 'POST') {
    const r = startRun({ dry: u.searchParams.get('dry') === '1', filter: u.searchParams.get('filter') || '', imap: u.searchParams.get('imap') !== '0' });
    return send(res, r.error ? 409 : 200, JSON.stringify(r), 'application/json');
  }
  if (u.pathname === '/api/log') {
    try { return send(res, 200, fs.readFileSync(path.join(OUT, 'run.log'), 'utf8').slice(-20000), MIME['.log']); }
    catch { return send(res, 404, 'Brak logu.'); }
  }
  if (u.pathname === '/api/history') return send(res, 200, JSON.stringify(history()), 'application/json');
  if (u.pathname.startsWith('/wyniki/')) {
    const f = safeFile(OUT, decodeURIComponent(u.pathname.slice(8)).split('?')[0]);
    if (f && fs.existsSync(f) && fs.statSync(f).isFile()) return send(res, 200, fs.readFileSync(f), MIME[path.extname(f)] || 'application/octet-stream');
    return send(res, 404, 'Brak pliku.');
  }
  if (u.pathname.startsWith('/historia/')) {
    const f = safeFile(HIST, decodeURIComponent(u.pathname.slice(10)).split('?')[0]);
    if (f && fs.existsSync(f)) return send(res, 200, fs.readFileSync(f), 'application/json');
    return send(res, 404, 'Brak pliku.');
  }
  return send(res, 404, 'Nie znaleziono.');
});

server.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}/?token=${TOKEN}`);
});

// Wbudowany harmonogram: SCHEDULE=daily -> pelny test z --imap codziennie o 06:00.
// (Alternatywa: cron systemu - przyklad w naglowku pliku.)
if ((process.env.SCHEDULE || '').toLowerCase() === 'daily') {
  let lastDay = '';
  setInterval(() => {
    const d = new Date();
    const day = d.toISOString().slice(0, 10);
    if (d.getHours() === 6 && d.getMinutes() < 5 && day !== lastDay && !status().running) {
      lastDay = day;
      console.log('[schedule] start codziennego testu');
      startRun({ imap: true, scheduleNote: 'daily 06:00' });
    }
  }, 60 * 1000);
  console.log('Harmonogram: codziennie 06:00 (SCHEDULE=daily).');
}
