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

const BADGE = v => ({ OK: '🟢 OK', BLAD: '🔴 BŁĄD', NIEPEWNY: '🟡 NIEPEWNY', RECZNIE: '🟡 RĘCZNIE', UKRYTY: '👻 UKRYTY', DRY: '⚪ DRY', POMINIETY: '⏭' }[v] || '❓ ' + v);

function dashboard(token) {
  const last = lastResults();
  const rows = last ? last.results.map(r =>
    `<tr><td><b>${r.name}</b><br><span class="s">${r.url}</span></td><td>${BADGE(r.verdict)}</td>` +
    `<td>${r.forms.map(f => `#${f.index + 1} ${BADGE(f.verdict)}`).join('<br>') || '<span class="s">—</span>'}</td></tr>`).join('')
    : '<tr><td colspan="3">Brak wyników — uruchom pierwszy test.</td></tr>';
  const hist = history().map(f => `<li><a href="/historia/${f}?token=${token}">${f}</a></li>`).join('') || '<li>—</li>';
  return `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Checker formularzy — dashboard</title>
<style>body{font-family:system-ui,Arial,sans-serif;background:#f8fafc;margin:0;color:#0f172a}
header{background:#0f172a;color:#fff;padding:14px 18px}main{max-width:1000px;margin:0 auto;padding:14px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{border-bottom:1px solid #e2e8f0;padding:7px;text-align:left}
.s{font-size:12px;opacity:.7}button{background:#0f172a;color:#fff;border:0;border-radius:8px;padding:9px 14px;cursor:pointer}
#run{font-weight:700}.spin{display:inline-block;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}</style></head>
<body><header><h2 style="margin:0">📋 Checker formularzy — dashboard</h2>
<div style="font-size:12.5px;opacity:.8" id="meta">${last ? `Ostatni run: ${last.code} • ${last.at} • ${last.dry ? 'DRY' : 'REALNA WYSYŁKA'}` : '—'}</div></header>
<main>
<div class="card"><span id="run">…</span>
 <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
  <button onclick="go(false)">▶ Uruchom test (wysyłka!)</button>
  <button onclick="go(true)">👁 Dry-run (bez wysyłki)</button>
  <a href="/wyniki/raport.html?token=${token}" target="_blank"><button>📄 Pełny raport</button></a>
  <a href="/api/log?token=${token}" target="_blank"><button>📜 Log</button></a>
 </div>
 <div class="s">Test wysyła PRAWDZIWE zgłoszenia TEST do klubów. Harmonogram: SCHEDULE=daily (codziennie 06:00) albo cron systemu (instrukcja w server.js).</div></div>
<div class="card"><table><thead><tr><th>Strona</th><th>Wynik</th><th>Formularze</th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="card"><b>Historia runów</b><ul>${hist}</ul></div>
</main>
<script>const T="${token}";
async function st(){const r=await fetch("/api/status?token="+T).then(x=>x.json());
document.getElementById("run").innerHTML=r.running?"<span class=spin>⏳</span> TEST TRWA (start "+(r.startedAt||"?")+") …odświeżam co 10 s":"✅ Gotowy do testu.";}
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
