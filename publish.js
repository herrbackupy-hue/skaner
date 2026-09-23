// Eksport statyczny wynikow na hosting wspoldzielony (tylko FTP, bez Node).
//   node publish.js            -> buduje katalog ./public (podglad lokalny)
//   node publish.js --upload   -> buduje + wysyla na FTP (dane z .env: FTP_*)
// Na serwer wgraj ZAWARTOSC katalogu public/ do np. /public_html/checker.
// Potem: https://twoja-domena.pl/checker/ pokazuje dashboard z historia.
//
// Typowy przeplyw na domowym PC (Task Scheduler, poniedzialki 06:00):
//   HEADLESS_ONLY=1 node check.js --imap  &&  node publish.js --upload
const fs = require('fs');
const path = require('path');
const { Client } = require('basic-ftp');

const DIR = __dirname;
const OUT = path.join(DIR, 'wyniki');
const HIST = path.join(DIR, 'historia');
const PUB = path.join(DIR, 'public');
const UPLOAD = process.argv.includes('--upload');

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const BADGE = v => ({ OK: '🟢 OK', BLAD: '🔴 BŁĄD', NIEPEWNY: '🟡 NIEPEWNY', RECZNIE: '🟡 RĘCZNIE', UKRYTY: '👻 UKRYTY', DRY: '⚪ DRY', POMINIETY: '⏭' }[v] || '❓ ' + v);
const codeOf = f => f.replace(/\.json$/, '');

function loadEnv() {
  const cfg = {};
  const p = path.join(DIR, '.env');
  if (!fs.existsSync(p)) return cfg;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) cfg[m[1]] = m[2];
  }
  return cfg;
}

function collectRuns() {
  const runs = [];
  const files = new Set(fs.existsSync(HIST) ? fs.readdirSync(HIST).filter(f => f.endsWith('.json')) : []);
  let current = null;
  try {
    current = JSON.parse(fs.readFileSync(path.join(OUT, 'wynik.json'), 'utf8'));
    if (current && current.code) files.add(current.code.replace(/[^A-Z0-9-]/gi, '') + '.json');
  } catch {}
  for (const f of [...files]) {
    let data = null;
    const hp = path.join(HIST, f);
    if (fs.existsSync(hp)) { try { data = JSON.parse(fs.readFileSync(hp, 'utf8')); } catch {} }
    if (!data && current && (current.code.replace(/[^A-Z0-9-]/gi, '') + '.json') === f) data = current;
    if (data) {
      let mt = 0;
      try { mt = fs.statSync(fs.existsSync(hp) ? hp : path.join(OUT, 'wynik.json')).mtimeMs; } catch {}
      runs.push({ file: f, code: codeOf(f), _mt: mt, ...data });
    }
  }
  runs.sort((a, b) => b._mt - a._mt);
  return runs;
}

function buildIndex(runs) {
  const last = runs[0];
  const rows = last ? last.results.map(r =>
    `<tr><td><b>${esc(r.name)}</b><br><span class="s">${esc(r.url)}</span></td><td>${BADGE(r.verdict)}</td>` +
    `<td>${r.forms.map(f => `#${f.index + 1} ${BADGE(f.verdict)}`).join('<br>') || '<span class="s">—</span>'}</td></tr>`).join('')
    : '<tr><td colspan="3">Brak wyników.</td></tr>';
  const hist = runs.map(r => {
    const ok = r.results.filter(x => x.verdict === 'OK').length;
    return `<li><a href="${r.code}-raport.html">${esc(r.code)}</a> — ${esc(r.at || '')} — 🟢 ${ok}/${r.results.length}${r.dry ? ' (DRY)' : ''}</li>`;
  }).join('') || '<li>—</li>';
  return `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Checker formularzy — wyniki</title>
<style>body{font-family:system-ui,Arial,sans-serif;background:#f8fafc;margin:0;color:#0f172a}
header{background:#0f172a;color:#fff;padding:14px 18px}main{max-width:1000px;margin:0 auto;padding:14px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{border-bottom:1px solid #e2e8f0;padding:7px;text-align:left}
.s{font-size:12px;opacity:.7}</style></head>
<body><header><h2 style="margin:0">📋 Checker formularzy — wyniki</h2>
<div style="font-size:12.5px;opacity:.8">${last ? `Ostatni run: ${esc(last.code)} • ${esc(last.at)} • ${last.dry ? 'DRY (bez wysyłki)' : 'REALNA WYSYŁKA'}` : 'Brak wyników'}</div></header>
<main><div class="card"><table><thead><tr><th>Strona</th><th>Wynik</th><th>Formularze</th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="card"><b>Historia runów</b><ul>${hist}</ul>
<p class="s">Legenda: 🟢 serwer przyjął zgłoszenie · 🔴 błąd · 🟡 do sprawdzenia ręcznie. HTTP 200 = „serwer przyjął”, NIE dowód dostarczenia e-maila. Szczegóły, kody odpowiedzi i screenshoty w raportach powyżej.</p></div></main></body></html>`;
}

(async () => {
  fs.mkdirSync(PUB, { recursive: true });
  const runs = collectRuns();
  if (!runs.length) { console.error('Brak wynikow (uruchom najpierw node check.js).'); process.exit(1); }
  console.log(`Runow: ${runs.length} (ostatni: ${runs[0].code})`);

  // raport + screenshoty kazdego runa pod unikalnymi nazwami
  // (kopiuj tylko png podlinkowane z biezacego raportu - reszta to sieroty po starszych runach)
  const curHtml = fs.existsSync(path.join(OUT, 'raport.html')) ? fs.readFileSync(path.join(OUT, 'raport.html'), 'utf8') : '';
  const pngs = [...curHtml.matchAll(/"([^"]+\.png)"/g)].map(m => m[1]).filter((v, i, a) => a.indexOf(v) === i && fs.existsSync(path.join(OUT, v)));
  for (const png of pngs) fs.copyFileSync(path.join(OUT, png), path.join(PUB, runs[0].code + '-' + png));
  for (const r of runs) {
    let html = null;
    const rp = path.join(OUT, 'raport.html');
    if (r.file === (runs[0].code + '.json') && fs.existsSync(rp)) html = fs.readFileSync(rp, 'utf8');
    if (!html) {
      // starszy run bez zachowanego raportu: generuj minimalny z JSON
      const rows = r.results.map(x => `<tr><td><b>${esc(x.name)}</b><br><span class="s">${esc(x.url)}</span></td><td>${BADGE(x.verdict)}</td><td>${esc(x.detail || '')}</td></tr>`).join('');
      html = `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8"><title>Raport ${esc(r.code)}</title></head><body><h2>Raport ${esc(r.code)} (${esc(r.at || '')})</h2><table border="1" cellpadding="6"><tr><th>Strona</th><th>Wynik</th><th>Info</th></tr>${rows}</table></body></html>`;
    } else {
      for (const png of pngs) html = html.split(`"${png}"`).join(`"${r.code}-${png}"`);
      // screenshoty starszych runow i tak pokazuja ostatni stan - uczciwa adnotacja
      if (r.file !== runs[0].code + '.json') html = html.replace('</header>', '</header><div style="background:#fef3c7;padding:8px 14px;font-size:13px">Archiwalny run — screenshoty ponizej pochodza z najnowszego runa.</div>');
    }
    fs.writeFileSync(path.join(PUB, r.code + '-raport.html'), html);
  }
  fs.writeFileSync(path.join(PUB, 'index.html'), buildIndex(runs));
  console.log(`Zbudowano public/ (${fs.readdirSync(PUB).length} plikow). Podglad: otworz public/index.html`);

  if (UPLOAD) {
    const env = loadEnv();
    for (const k of ['FTP_HOST', 'FTP_USER', 'FTP_PASS', 'FTP_DIR']) {
      if (!env[k] || /WPISZ|twoja-domena|login-ftp|haslo-ftp/i.test(env[k])) {
        console.error(`Brak danych FTP w .env (${k}). Uzupelnij wg .env.example.`);
        process.exit(1);
      }
    }
    const c = new Client();
    try {
      await c.access({ host: env.FTP_HOST, user: env.FTP_USER, password: env.FTP_PASS, secure: false });
      await c.ensureDir(env.FTP_DIR);
      await c.clearWorkingDir();
      await c.uploadFromDir(PUB);
      console.log(`Wyslane na FTP ${env.FTP_HOST}${env.FTP_DIR} -> otworz w przegladarce adres strony + /checker/ (lub inny katalog z FTP_DIR).`);
    } finally { c.close(); }
  }
})().catch(e => { console.error('FATAL: ' + e.message); process.exit(2); });
