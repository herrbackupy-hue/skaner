// Checker formularzy v2 — Node + Playwright.
// Dla kazdego URL znajduje WSZYSTKIE formularze i testuje kazdy z osobna.
// Uzycie:
//   node check.js --dry              -> tylko wypelnia pola + screenshoty, NIC nie wysyla (bezpieczne)
//   node check.js                    -> PELNY test: realnie wysyla formularze z oznaczeniem TEST-xxx
//   node check.js --filter=hydro     -> tylko strony z "hydro" w nazwie
//   node check.js --headed           -> widoczna przegladarka (pomocne przy CAPTCHA / debug)
// Wynik: ./wyniki/raport.html + ./wyniki/wynik.json + screenshoty.
// UWAGA: pelny run wysyla PRAWDZIWE zgloszenia (grzecznosciowe dane + kod TEST).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { findCode, loadEnv } = require('./imap-check');
const { CSS, pill, esc, formTitle } = require('./layout');

const ARGS = process.argv.slice(2);
const DRY = ARGS.includes('--dry');
const HEADED = ARGS.includes('--headed');
const FILTERS = ((ARGS.find(a => a.startsWith('--filter=')) || '=').split('=')[1] || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const ONLY_FORM = parseInt(((ARGS.find(a => a.startsWith('--form=')) || '=').split('=')[1] || ''), 10) || 0; // --form=2 testuje tylko 2. formularz
const WITH_IMAP = ARGS.includes('--imap'); // po wysylce szuka kodu w skrzynce testowej (.env)
const HEADLESS_ONLY = process.env.HEADLESS_ONLY === '1'; // tryb serwerowy: bez przegladarki headed
const SKIP_FIELDS = ((ARGS.find(a => a.startsWith('--skip-field=')) || '=').split('=')[1] || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const EMAIL_OVERRIDE = ((ARGS.find(a => a.startsWith('--email=')) || '=').split('=')[1] || '').trim();
const PHONE_OVERRIDE = ((ARGS.find(a => a.startsWith('--phone=')) || '=').split('=')[1] || '').trim();
const NAME_OVERRIDE = ((ARGS.find(a => a.startsWith('--name=')) || '=').split('=')[1] || '').trim();
const OUTDIR = (() => {
  const o = ARGS.find(a => a.startsWith('--out='));
  return o ? path.resolve(o.split('=')[1]) : path.join(__dirname, 'wyniki');
})();

const CODE = 'TEST-' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-'
  + Math.random().toString(36).slice(2, 6).toUpperCase();
const PROFILE_DIR = path.join(__dirname, 'profil-chrome'); // trwaly profil: przepustka antybota pamietana miedzy runami
const TEST_NAME = 'Test Checker'; // BEZ cyfr/kodu: niektore backendy (np. Hydro) odrzucaja cyfry w imieniu (400). Kod testu i tak jest w e-mailu i tresci wiadomosci.
const TEST_EMAIL = 'checker.' + CODE.toLowerCase() + '@example.com';
const TEST_PHONE = '600100200';
const TEST_MSG = 'Automatyczny test formularza ' + CODE + ' - prosze zignorowac.';

const SUCCESS_RE = /dzi[eę]kuj|dzi[eę]ki|przyj[eę]t|odezwiemy|potwierdz|wysłan[oe]|zgłoszenie|rezerwacj|gratulac|sukces|przyjeli[śs]my|success|thank you|message sent/i;
const URL_SUCCESS_RE = /wyslano|wysłano|success|dziekuje|thank|potwierdzenie|formularz=(ok|success|wyslano)/i;
const ERROR_RE = /błąd|nie udało|spróbuj ponownie|wystąpił problem|nieprawidłow|uzupełnij|pole .* wymagane|failed|error\W/i;
const CAPTCHA_RE = /recaptcha|g-recaptcha|hcaptcha|turnstile|cf-turnstile|captcha/i;
const MARKETING_RE = /marketing|newsletter|handlow|promoc|reklam|ofert.*mail|mail.*ofert/i;
const CHALLENGE_RE = /prosz[eę] czeka|weryfikacj|just a moment|checking your browser|attention required|verify you are human|potwierd[źz].*nie jesteś robotem/i;

const slug = s => (s || 'strona').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/ł/g, 'l').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'strona';
const now = () => new Date().toLocaleString('pl-PL');

async function dismissCookies(page) {
  try {
    const btns = await page.$$('button, a.btn, [role="button"]');
    for (const b of btns) {
      let t = '';
      try { t = (await b.innerText() || '').trim(); } catch { continue; }
      if (/^(akceptuj.*|zgoda|rozumiem|accept.*|ok|wyra[żz]am zgod[eę])$/i.test(t)) {
        try { if (await b.isVisible()) { await b.click({ timeout: 2000 }); await page.waitForTimeout(600); break; } } catch { /* dalej */ }
      }
    }
  } catch { /* ignoruj */ }
}

async function pageText(page) {
  for (let i = 0; i < 3; i++) {
    try { return { title: await page.title(), body: (await page.evaluate(() => document.body.innerText)).slice(0, 2000) }; }
    catch { await page.waitForTimeout(2500); }
  }
  return { title: '', body: '' };
}

// Czeka az strona sie doczyta LUB minie limit. Wykrywa challenge antybotowy.
// Zwraca 'ready' | 'challenge' (challenge nie przeszedl w limicie czasu).
async function waitForContent(page, secs = 50) {
  let challengeHits = 0;
  for (let t = 0; t < secs; t += 5) {
    await page.waitForTimeout(5000);
    const { title, body } = await pageText(page);
    if (CHALLENGE_RE.test(title + ' ' + body.slice(0, 300))) {
      if (++challengeHits >= 4) return 'challenge'; // challenge nie puszcza automatow - nie czekaj dluzej
      continue;
    }
    challengeHits = 0;
    try {
      const n = await page.evaluate(() => document.querySelectorAll('form,input,textarea,select').length);
      if (n > 0) return 'ready';
    } catch { /* nawigacja w trakcie */ }
    if (body.length > 800) return 'ready';
  }
  const { title, body } = await pageText(page);
  return CHALLENGE_RE.test(title + ' ' + body.slice(0, 300)) ? 'challenge' : 'ready';
}

async function visibleForms(page) {
  const handles = await page.$$('form');
  const out = [];
  for (const h of handles) {
    try {
      const box = await h.boundingBox();
      if (!box || box.width < 50 || box.height < 20) continue;
      const info = await h.evaluate(f => ({
        id: f.id || '', cls: (f.className || '').toString().slice(0, 80),
        action: f.action || '', method: (f.method || 'get').toUpperCase(),
        fields: f.querySelectorAll('input,textarea,select').length,
        html: f.outerHTML.slice(0, 3000),
      }));
      info.hasCaptcha = CAPTCHA_RE.test(info.html);
      // naglowek w poblizu formularza
      try {
        info.heading = await h.evaluate(f => {
          const prev = f.previousElementSibling;
          const t = (prev && prev.innerText || '').trim().slice(0, 120);
          return t || (f.closest('section')?.querySelector('h1,h2,h3')?.innerText || '').trim().slice(0, 120);
        });
      } catch { info.heading = ''; }
      out.push({ handle: h, ...info });
    } catch { /* formularz zniknal */ }
  }
  return out;
}

async function fillForm(page, form) {
  const filled = [];
  const inputs = await form.handle.$$('input, textarea, select');
  for (const el of inputs) {
    try {
      if (!await el.isVisible()) continue;
      const tag = (await el.evaluate(e => e.tagName)).toLowerCase();
      const type = ((await el.getAttribute('type')) || (tag === 'textarea' ? 'textarea' : 'text')).toLowerCase();
      if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'file') continue;
      const meta = await el.evaluate(e => ({
        name: e.name || '', id: e.id || '', ph: e.placeholder || '',
        label: e.closest('label')?.innerText?.slice(0, 100) || '',
      }));
      const hay = `${meta.name} ${meta.id} ${meta.ph} ${meta.label}`.toLowerCase();
      if (SKIP_FIELDS.some(s => hay.includes(s))) { filled.push(`pominieto:${meta.name || meta.id}`); continue; }
      // Honeypot: pole technicznie "widoczne", ale poza ekranem / przezroczyste.
      // Czlowieka tam nie ma - bot tez ma zostawic puste, inaczej backend slusznie odrzuca jako spam.
      if (tag !== 'select' && !['checkbox', 'radio'].includes(type)) {
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(300);
        const trap = await el.evaluate(e => {
          const r = e.getBoundingClientRect();
          const cs = getComputedStyle(e);
          const vw = window.innerWidth, vh = window.innerHeight;
          const outside = (r.x + r.width < 0 || r.y + r.height < 0 || r.x > vw || r.y > vh);
          return (r.width === 0 || r.height === 0 || cs.opacity === '0' || cs.visibility === 'hidden' || cs.display === 'none' || outside);
        }).catch(() => false);
        if (trap) { filled.push(`honeypot-puste:${meta.name || meta.id}`); continue; }
      }

      if (tag === 'select') {
        const opts = await el.$$('option');
        for (const o of opts) {
          const v = await o.getAttribute('value');
          if (v) { await el.selectOption(v); filled.push(`select:${meta.name || meta.id}=${v}`); break; }
        }
        continue;
      }
      if (type === 'checkbox') {
        const required = await el.evaluate(e => e.required);
        if (!required && MARKETING_RE.test(hay)) continue; // zgody marketingowe pomijamy
        await el.check({ force: true }).catch(() => {});
        filled.push(`check:${meta.name || meta.id || meta.label.slice(0, 20)}`);
        continue;
      }
      if (type === 'radio') {
        const nm = await el.getAttribute('name');
        const anyChecked = nm ? await form.handle.$(`input[type="radio"][name="${nm}"]:checked`) : null;
        if (!anyChecked) { await el.check({ force: true }).catch(() => {}); filled.push(`radio:${nm}`); }
        continue;
      }
      if (type === 'email' || /e-?mail/.test(hay)) { await el.fill(EMAIL_OVERRIDE || TEST_EMAIL); filled.push('email' + (EMAIL_OVERRIDE ? '(override)' : '')); }
      else if (type === 'tel' || /telefon|phone|tel\./.test(hay)) { await el.fill(PHONE_OVERRIDE || TEST_PHONE); filled.push('tel' + (PHONE_OVERRIDE ? '(override)' : '')); }
      else if (tag === 'textarea' || /wiadomo|message|tresc|opis|pytanie|cel|uwag/.test(hay)) { await el.fill(TEST_MSG); filled.push('msg'); }
      else if (/imie|name|nazwisko|imie i nazwisko/.test(hay)) { await el.fill(NAME_OVERRIDE || TEST_NAME); filled.push('name' + (NAME_OVERRIDE ? '(override)' : '')); }
      else { await el.fill('TEST ' + CODE); filled.push(`text:${meta.name || meta.id || 'pole'}`); }
    } catch { /* pole nie do wypelnienia */ }
  }
  return filled;
}

async function submitForm(form) {
  const btn = await form.handle.$('button[type="submit"], input[type="submit"], button:not([type])');
  if (btn && await btn.isVisible().catch(() => false)) {
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click({ timeout: 5000 });
    return 'click';
  }
  await form.handle.evaluate(f => f.requestSubmit());
  return 'requestSubmit';
}

async function testForm(page, site, form, idx, reqLog) {
  const r = { index: idx, heading: form.heading, id: form.id, action: form.action, method: form.method, fields: form.fields, hasCaptcha: form.hasCaptcha };
  const tag = `${slug(site.name)}-f${idx + 1}`;
  reqLog.length = 0;
  r.beforePng = tag + '-przed.png';
  await page.screenshot({ path: path.join(OUTDIR, r.beforePng) }).catch(() => {});
  r.filled = await fillForm(page, form);
  r.filledPng = tag + '-wypelniony.png';
  await page.screenshot({ path: path.join(OUTDIR, r.filledPng) }).catch(() => {});

  if (!r.filled.length) {
    r.verdict = 'UKRYTY';
    r.detail = 'Nie dalo sie wypelnic zadnego pola (zakladka/popup/pola warunkowe?) - do testu recznego.';
    return r;
  }

  if (DRY) { r.verdict = 'DRY'; r.detail = 'Tryb --dry: wypelniono, nie wyslano.'; return r; }
  if (form.hasCaptcha) r.captchaNote = 'Wykryto CAPTCHA (reCAPTCHA/Turnstile/hCaptcha) - automat moze zostac zablokowany.';

  const before = reqLog.length;
  r.submitVia = await submitForm(form).catch(e => 'submit-error: ' + e.message.split('\n')[0]);
  await page.waitForTimeout(9000);
  const newReqs = reqLog.slice(before).filter(x => x.method === 'POST' || x.method === 'PUT' || /contact|form|lead|mail|send|submit|api/i.test(x.url));
  r.requests = newReqs.map(x => `${x.method} ${x.status} ${x.url.slice(0, 110)}`);
  r.badStatus = newReqs.some(x => x.status >= 400);
  let bodyText = '';
  try { bodyText = (await page.evaluate(() => document.body.innerText)).slice(0, 4000); } catch { bodyText = '(brak dostepu do tresci)'; }
  r.successHit = SUCCESS_RE.test(bodyText);
  r.errorHit = ERROR_RE.test(bodyText);
  r.afterPng = tag + '-po.png';
  r.finalUrl = page.url();
  r.urlSuccess = URL_SUCCESS_RE.test(r.finalUrl);
  await page.screenshot({ path: path.join(OUTDIR, r.afterPng), fullPage: false }).catch(() => {});

  if ((r.successHit || r.urlSuccess) && !r.errorHit && !r.badStatus) { r.verdict = 'OK'; r.detail = r.urlSuccess && !r.successHit ? 'Przekierowanie na URL sukcesu (' + r.finalUrl.slice(-60) + ').' : 'Wykryto komunikat sukcesu, brak bledow HTTP.'; }
  else if (r.errorHit || r.badStatus) { r.verdict = 'BLAD'; r.detail = (r.badStatus ? 'Zadanie HTTP ≥400. ' : '') + (r.errorHit ? 'Wykryto komunikat bledu na stronie.' : ''); }
  else if (form.hasCaptcha) { r.verdict = 'RECZNIE'; r.detail = 'CAPTCHA na formularzu - wymaga recznego testu w trybie --headed.'; }
  else { r.verdict = 'NIEPEWNY'; r.detail = 'Brak jednoznacznego sukcesu/bledu - sprawdz screenshot „po”.'; }
  return r;
}

async function testSite(browser, site, persistentCtx) {
  const res = { name: site.name, url: site.url, mail: site.mail || '', checkedAt: now(), forms: [], verdict: 'BLAD', detail: '' };
  let ctx, page;
  try {
    if (persistentCtx) {
      page = await persistentCtx.newPage();
    } else {
      ctx = await browser.newContext({
        locale: 'pl-PL', viewport: { width: 1366, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      });
      page = await ctx.newPage();
    }
    const reqLog = [];
    page.on('response', async resp => { try { reqLog.push({ url: resp.url(), status: resp.status(), method: resp.request().method() }); } catch {} });
    page.on('pageerror', e => { res.jsErrors = (res.jsErrors || []).concat(e.message.split('\n')[0]); });

    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
    const state = await waitForContent(page);
    if (state === 'challenge') {
      res.verdict = 'BLAD'; res.challengeBlocked = true;
      res.detail = 'Antybot (challenge „Proszę czekać…”) nie przepuscil przegladarki headless. Ponowie w trybie headed.';
      try { await page.screenshot({ path: path.join(OUTDIR, slug(site.name) + '-challenge.png') }); } catch {}
      return res;
    }
    res.title = (await pageText(page)).title;
    await dismissCookies(page);

    // KROK 1: spis wszystkich widocznych formularzy (sama strona, bez wysylki)
    const plan = (await visibleForms(page)).map((f, i) => ({ index: i, heading: f.heading, id: f.id, action: f.action, method: f.method, fields: f.fields, hasCaptcha: f.hasCaptcha }));
    res.formsFound = plan.length;
    if (!plan.length) { res.verdict = 'BLAD'; res.detail = 'Nie znaleziono widocznego formularza <form> na stronie.'; return res; }

    // KROK 2: kazdy formularz testujemy na SWIEZO zaladowanej stronie
    // (unikamy zastałych uchwytów po nawigacji i "sukcesów" z poprzedniego formularza)
    for (const p of plan) {
      if (ONLY_FORM && p.index + 1 !== ONLY_FORM) {
        res.forms.push({ ...p, filled: [], verdict: 'POMINIETY', detail: `Pominieto przez --form=${ONLY_FORM}.` });
        continue;
      }
      if (p.fields === 0) {
        res.forms.push({ ...p, filled: [], verdict: 'POMINIETY', detail: 'Formularz bez pól (techniczny) - pominieto.' });
        continue;
      }
      await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      try { await page.waitForLoadState('networkidle', { timeout: 12000 }); } catch {}
      await waitForContent(page, 25);
      await dismissCookies(page);
      const fresh = await visibleForms(page);
      const match = fresh.find(f => f.action === p.action && f.fields === p.fields)
        || fresh[p.index] || fresh[0];
      if (!match) {
        res.forms.push({ ...p, filled: [], verdict: 'UKRYTY', detail: 'Formularz niewidoczny na swiezej stronie (popup/modal?) - do testu recznego.' });
        continue;
      }
      if ((match.action !== p.action || match.fields !== p.fields) && fresh.length !== plan.length) {
        res.forms.push({ ...p, filled: [], verdict: 'UKRYTY', detail: 'Nie odnaleziono tego formularza po przeladowaniu (popup/modal?) - do testu recznego.' });
        continue;
      }
      const fr = await testForm(page, site, match, p.index, reqLog);
      res.forms.push(fr);
      await page.waitForTimeout(1000);
    }
    const v = res.forms.map(f => f.verdict);
    if (v.includes('BLAD')) { res.verdict = 'BLAD'; res.detail = 'Co najmniej jeden formularz zakonczyl sie bledem.'; }
    else if (v.includes('NIEPEWNY')) { res.verdict = 'NIEPEWNY'; res.detail = 'Wymaga rzutu oka na screenshoty.'; }
    else if (v.includes('RECZNIE') || v.includes('UKRYTY')) { res.verdict = 'RECZNIE'; res.detail = 'Formularze z CAPTCHA / ukryte (popup) do testu recznego.'; }
    else if (v.includes('DRY')) { res.verdict = 'DRY'; res.detail = 'Tryb probny.'; }
    else { res.verdict = 'OK'; res.detail = 'Wszystkie formularze: sukces.'; }
  } catch (e) {
    res.verdict = 'BLAD'; res.detail = 'Wyjatek: ' + String(e.message || e).split('\n')[0];
  } finally {
    try { if (persistentCtx && page) await page.close(); else if (ctx) await ctx.close(); } catch {}
  }
  return res;
}

function buildReport(results, mail) {
  const flat = results.flatMap(r => (r.forms.length ? r.forms : [null]).map(f => ({ r, f })));
  const ok = flat.filter(({ f }) => (f ? f.verdict : null) === 'OK').length;
  const bad = flat.filter(({ f }) => (f ? f.verdict : null) === 'BLAD').length;
  const mailBox = !mail ? '' : mail.checked
    ? `<div class="note">Skrzynka testowa ${esc(mail.box)}: ${mail.found.length
      ? `znaleziono <b>${mail.found.length}</b> potwierdzen z kodem: ` + mail.found.map(f => esc(`${f.from} (${f.subject})`)).join('; ')
      : 'BRAK wiadomosci z kodem (sprawdz folder SPAM recznie).'}${(mail.errors || []).map(e => `<br>Uwaga: ${esc(e)}`).join('')}</div>`
    : (mail.reason ? `<div class="note">IMAP pominieto: ${esc(mail.reason)}</div>` : '');
  const rows = results.flatMap(r => {
    const siteCell = `<b>${esc(r.name)}</b><br><span class="s">${esc(r.checkedAt)}</span>`;
    const urlCell = `<span class="url"><a href="${esc(r.url)}" target="_blank">${esc(r.url)}</a></span>${r.mail ? `<br><span class="s">${esc(r.mail)}</span>` : ''}`;
    if (!r.forms.length) return [`<tr><td>${siteCell}</td><td>${urlCell}</td><td>${pill(r.verdict)}<br><span class="s">${esc(r.detail)}</span></td></tr>`];
    return r.forms.map((f, fi) => `<tr><td>${siteCell}<br><span class="s">${esc(formTitle(f))}</span>${fi === 0 ? (r.mailHits || []).map(h => `<br><span class="code">doszło od ${esc(h.from)}</span>`).join('') : ''}</td><td>${urlCell}</td>
      <td>${pill(f.verdict)}
      <span class="s">pól: ${f.fields} · ${esc(f.method || '')} ${esc((f.action || '').slice(0, 80))}${f.hasCaptcha ? ' · CAPTCHA' : ''}</span><br>
      <span class="s">Wypełniono: ${esc((f.filled || []).join(', ') || '—')} · wysyłka: ${esc(f.submitVia || '—')}</span><br>
      ${(f.requests || []).map(q => `<span class="code">${esc(q)}</span>`).join('<br>')}${(f.requests || []).length ? '<br>' : ''}
      <span class="s">${esc(f.detail || '')} ${esc(f.captchaNote || '')}</span><br>
      <span class="shot">${['beforePng', 'filledPng', 'afterPng'].filter(k => f[k]).map(k => `<a href="${f[k]}" target="_blank">${k.replace('Png', '')}</a>`).join(' · ')}</span>
    </td></tr>`);
  }).join('');
  return `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Raport formularzy ${esc(CODE)}</title><style>${CSS}</style></head>
<body><div class="top"><h1>Raport kontroli formularzy — ${esc(CODE)}${DRY ? ' (test próbny)' : ''}</h1>
<div class="meta">${esc(now())} · tryb: ${DRY ? 'próbny (bez wysyłki)' : 'realna wysyłka z kodem ' + esc(CODE)}</div>
<div class="chips"><span class="chip">Formularzy: <b>${flat.length}</b></span><span class="chip">Działa: <b>${ok}</b></span><span class="chip">Błędów: <b>${bad}</b></span></div></div>
<div class="wrap">${mailBox}<div class="card"><table><thead><tr><th style="width:24%">Strona i formularz</th><th style="width:26%">Adres</th><th>Wynik i szczegóły</th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="footer">„Działa" = komunikat sukcesu lub adres sukcesu + brak błędów HTTP. „Błąd" = błąd HTTP, komunikat błędu lub wyjątek. „Do sprawdzenia / Test ręczny / Ukryty" = obejrzyj zrzuty ekranu albo przetestuj ręcznie (CAPTCHA, popup). Potwierdzenie zwrotne dowodzi, że silnik mailowy działa — nie dowodzi, że lead doszedł do klubu (to wymaga dopisania skrzynki testowej jako BCC). Kod HTTP 200 znaczy „serwer przyjął", nie „e-mail dostarczony".</div></div></body></html>`;
}

function printSite(r) {
  const icon = { OK: '🟢', BLAD: '🔴', NIEPEWNY: '🟡', RECZNIE: '🟡', UKRYTY: '👻', DRY: '⚪', POMINIETY: '⏭' }[r.verdict] || '❓';
  console.log(`   ${icon} ${r.verdict} — formularzy: ${r.formsFound ?? r.forms.length} — ${r.detail}`);
  r.forms.forEach(f => console.log(`      - form #${f.index + 1}: ${f.verdict} (${(f.filled || []).length} pol, CAPTCHA:${f.hasCaptcha ? 'TAK' : 'nie'})`));
}

(async () => {
  if (ARGS.includes('--help')) {
    console.log([
      'Uzycie: node check.js [opcje]',
      '  --dry               tylko wypelnia + screenshoty, NIC nie wysyla',
      '  --headed            widoczna przegladarka (lokalnie)',
      '  --filter=a,b        tylko strony z "a" lub "b" w nazwie/URL',
      '  --form=N            tylko N-ty formularz na stronie (retest)',
      '  --email=a@b.c       nadpisz testowy e-mail',
      '  --phone=600100200   nadpisz testowy telefon (9-10 cyfr, BEZ spacji)',
      '  --name="Jan Testowy" nadpisz imie (BEZ cyfr - czesc backendow je odrzuca)',
      '  --skip-field=x,y    pomin pola z "x"/"y" w nazwie',
      '  --imap              po wysylce szukaj kodu w skrzynce testowej (.env)',
      '  --out=./wyniki      katalog wynikow',
      'Zmienne srodowiskowe: HEADLESS_ONLY=1 (serwer: bez przegladarki headed).',
    ].join('\n'));
    process.exit(0);
  }
  fs.mkdirSync(OUTDIR, { recursive: true });
  const sites = JSON.parse(fs.readFileSync(path.join(__dirname, 'strony.json'), 'utf8'))
    .filter(s => !FILTERS.length || FILTERS.some(f => (s.name + s.url).toLowerCase().includes(f)));
  if (!sites.length) { console.error('Brak stron (zly --filter?).'); process.exit(1); }
  console.log(`Kod testu: ${CODE} | tryb: ${DRY ? 'DRY (bez wysylki)' : 'REALNA WYSYLKA'} | stron: ${sites.length}`);

  const browser = await chromium.launch({ headless: !HEADED });
  const results = [];
  for (const s of sites) {
    console.log(`\n== ${s.name} (${s.url})`);
    const r = await testSite(browser, s);
    results.push(r);
    printSite(r);
  }
  // Strony zablokowane przez antybot w headless -> ponowienie w PRAWDZIWYM Chrome (trwaly profil).
  // Na serwerze (HEADLESS_ONLY=1) nie ma ekranu - od razu oznacz do recznego testu.
  const blocked = results.filter(r => r.challengeBlocked);
  if (blocked.length && !HEADED && !HEADLESS_ONLY) {
    console.log(`\n!! ${blocked.length} stron z challenge antybotowym - ponawiam w prawdziwym Chrome (nie zamykaj okna)...`);
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    let hb = null;
    try {
      hb = await chromium.launchPersistentContext(PROFILE_DIR, {
        ...(process.env.USE_REAL_CHROME === '1' ? { channel: 'chrome' } : {}),
        headless: false, locale: 'pl-PL',
        viewport: { width: 1366, height: 900 },
        args: ['--disable-blink-features=AutomationControlled'],
      });
    } catch (e) { hb = null; }
    if (!hb) {
      for (const r of blocked) {
        r.verdict = 'RECZNIE'; r.challengeBlocked = false;
        r.detail = 'Antybot zablokowal automatyzacje - przetestuj recznie (v1: form-checker.html).';
        printSite(r);
      }
    } else {
      for (const r of blocked) {
        const site = sites.find(s => s.name === r.name);
        console.log(`\n== [real-chrome retry] ${site.name}`);
        const r2 = await testSite(null, site, hb);
        delete r2.challengeBlocked;
        if (r2.challengeBlocked || (r2.verdict === 'BLAD' && /challenge/i.test(r2.detail))) {
          r2.verdict = 'RECZNIE'; r2.challengeBlocked = false;
          r2.detail = 'Antybot blokuje tez automatyzacje - otworz strone w zwyklej przegladarce i przetestuj recznie (v1: form-checker.html).';
        }
        Object.assign(r, r2);
        printSite(r);
      }
      await hb.close();
    }
  } else if (blocked.length && HEADLESS_ONLY) {
    for (const r of blocked) {
      r.verdict = 'RECZNIE'; r.challengeBlocked = false;
      r.detail = 'Antybot zablokowal przegladarke serwerowa (brak ekranu) - przetestuj recznie lub z domowego PC.';
    }
  }
  await browser.close();

  // Wariant B: szukanie kodu w skrzynce testowej (potwierdzenia zwrotne)
  let mail = { checked: false };
  if (WITH_IMAP && !DRY) {
    const { cfg, missing } = loadEnv();
    if (missing) {
      mail = { checked: false, reason: 'Brak .env z danymi skrzynki (skopiuj .env.example -> .env).' };
      console.log('\n--imap: pomijam (brak .env).');
    } else {
      const waitMin = Math.max(1, parseInt(cfg.MAIL_WAIT_MIN || '5', 10));
      const runStart = new Date(Date.now() - 1000 * 60 * 60); // bufor: szukaj od godziny przed startem
      console.log(`\n--imap: czekam ${waitMin} min na potwierdzenia zwrotne @${cfg.IMAP_USER}...`);
      for (let m = 0; m < waitMin; m++) { await new Promise(r => setTimeout(r, 60000)); console.log(`   ...${m + 1}/${waitMin} min`); }
      const { found, errors } = await findCode({ ...cfg, code: CODE, since: runStart, logger: console.log });
      mail = { checked: true, box: cfg.IMAP_USER, found, errors };
      // dopasowanie potwierdzen do stron po domenie nadawcy
      for (const r of results) {
        let host = '';
        try { host = new URL(r.url).hostname.replace(/^www\./, '').toLowerCase(); } catch {}
        const mailDom = (r.mail || '').split('@')[1] || '';
        r.mailHits = (found || []).filter(f =>
          (host && (f.fromDomain === host || f.fromDomain.endsWith('.' + host))) ||
          (mailDom && f.fromDomain === mailDom.toLowerCase()));
      }
      console.log(found.length ? `✉️  Znaleziono ${found.length} wiadomosci z kodem.` : '✉️  Brak wiadomosci z kodem (sprawdz SPAM recznie).');
    }
  } else if (WITH_IMAP && DRY) {
    mail = { checked: false, reason: 'Tryb --dry: nic nie wyslano, nie ma czego szukac.' };
  }

  fs.writeFileSync(path.join(OUTDIR, 'wynik.json'), JSON.stringify({ code: CODE, dry: DRY, at: now(), mail, results }, null, 2));
  fs.writeFileSync(path.join(OUTDIR, 'raport.html'), buildReport(results, mail));
  try {
    const hd = path.join(__dirname, 'historia');
    fs.mkdirSync(hd, { recursive: true });
    fs.copyFileSync(path.join(OUTDIR, 'wynik.json'), path.join(hd, CODE.replace(/[^A-Z0-9-]/gi, '') + '.json'));
    const files = fs.readdirSync(hd).filter(f => f.endsWith('.json')).sort();
    while (files.length > 20) fs.unlinkSync(path.join(hd, files.shift()));
  } catch {}
  const ok = results.filter(r => r.verdict === 'OK').length;
  console.log(`\nGotowe: ${ok}/${results.length} OK. Raport: ${path.join(OUTDIR, 'raport.html')}`);
})().catch(e => { console.error('FATAL: ' + e.message); process.exit(2); });
