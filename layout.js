// Wspolny, spokojny wygląd raportow (bez emoji, bez kreskowek).
// Uzywaja: check.js (raport.html), publish.js (index.html), server.js (dashboard).
const CSS = `
:root{--ink:#0f172a;--mut:#64748b;--line:#e2e8f0;--bg:#f1f5f9;--card:#ffffff;
--ok:#15803d;--okbg:#dcfce7;--err:#b91c1c;--errbg:#fee2e2;
--warn:#b45309;--warnbg:#fef3c7;--info:#475569;--infobg:#eef2f7;--accent:#2563eb}
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:var(--bg);margin:0;color:var(--ink);font-size:14px;line-height:1.45}
.top{background:#0f172a;color:#fff;padding:22px 20px 18px;border-bottom:3px solid var(--accent)}
.top h1{margin:0;font-size:20px;font-weight:650;letter-spacing:.2px}
.top .meta{margin-top:6px;font-size:12.5px;color:#cbd5e1}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.chip{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:4px 12px;font-size:12.5px}
.chip b{font-weight:700}
.wrap{max-width:1120px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:0;margin-bottom:14px;overflow:hidden;box-shadow:0 1px 2px rgba(15,23,42,.05)}
table{width:100%;border-collapse:collapse;font-size:13.5px}
thead th{background:#f8fafc;text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.6px;color:var(--mut);padding:10px 12px;border-bottom:1px solid var(--line);position:sticky;top:0}
tbody td{padding:11px 12px;border-bottom:1px solid var(--line);vertical-align:top}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:#f8fafc}
.s{font-size:12px;color:var(--mut)}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.pill{display:inline-flex;align-items:center;gap:7px;padding:3px 11px 3px 9px;border-radius:999px;font-size:12px;font-weight:650;white-space:nowrap}
.pill::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}
.p-ok{background:var(--okbg);color:var(--ok)}
.p-err{background:var(--errbg);color:var(--err)}
.p-warn{background:var(--warnbg);color:var(--warn)}
.p-info{background:var(--infobg);color:var(--info)}
code,.code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;background:#0f172a;color:#bae6fd;padding:2px 7px;border-radius:6px;white-space:nowrap}
.url{font-size:12.5px;word-break:break-all}
.btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.btn{background:var(--ink);color:#fff;border:0;border-radius:8px;padding:9px 15px;font-size:13.5px;cursor:pointer}
.btn.sec{background:#fff;color:var(--ink);border:1px solid var(--line)}
.note{background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:10px 14px;font-size:13px;margin-bottom:14px}
.footer{font-size:12px;color:var(--mut);padding:4px 2px 20px}
.shot{font-size:12px}
@media(max-width:720px){thead{display:none}table,tbody,tr,td{display:block}tbody td{border-bottom:0;padding:5px 12px}tbody tr{border-bottom:1px solid var(--line);padding:6px 0}}`;

const LABEL = {
  OK: ['p-ok', 'Działa'],
  BLAD: ['p-err', 'Błąd'],
  NIEPEWNY: ['p-warn', 'Do sprawdzenia'],
  RECZNIE: ['p-warn', 'Test ręczny'],
  UKRYTY: ['p-warn', 'Ukryty'],
  DRY: ['p-info', 'Test próbny'],
  POMINIETY: ['p-info', 'Pominięty'],
};
const pill = v => {
  const [c, t] = LABEL[v] || ['p-info', v || '—'];
  return `<span class="pill ${c}">${t}</span>`;
};
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const formTitle = f => `Formularz ${f.index + 1}${f.heading ? ' — ' + f.heading : (f.id ? ' (' + f.id + ')' : '')}`;

module.exports = { CSS, pill, esc, formTitle, LABEL };
