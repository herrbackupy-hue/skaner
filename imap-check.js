// Modul IMAP do wariantu B: szuka kodu TEST-xxx w skrzynce testowej.
// Skrzynka testowa lapie POTWIERDZENIA ZWROTNE (maile, ktore formularz wysyla
// na adres wpisany w formularzu). To dowod "silnik mailowy dziala", NIE dowod
// "lead doszedl do klubu" (ten leci na skrzynke klubu, do ktorej nie mamy dostepu).
//
// Uzycie samodzielne:
//   node imap-check.js --code=TEST-260923-XXXX   (szuka od dzisiaj 00:00)
//   node imap-check.js --code=... --since-min=30 (szuka z ostatnich 30 min)
// Konfiguracja: plik .env obok (patrz .env.example).
const { ImapFlow } = require('imapflow');
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const cfg = { IMAP_HOST: '', IMAP_PORT: '993', IMAP_USER: '', IMAP_PASS: '', MAIL_WAIT_MIN: '5' };
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return { cfg, missing: true };
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) cfg[m[1]] = m[2];
  }
  return { cfg, missing: !cfg.IMAP_USER || !cfg.IMAP_PASS || /WPISZ/i.test(cfg.IMAP_PASS) };
}

function senderDomain(msg) {
  const a = (msg.envelope && (msg.envelope.from || [])[0] || {}).address || '';
  return (a.split('@')[1] || '').toLowerCase();
}

// Szuka kodu w INBOX (+ proba folderu Spam dla Gmaila). Zwraca { found, errors }.
// found: [{ uid, folder, from, fromDomain, subject, date }]
async function findCode({ host, port, user, pass, code, since, logger }) {
  const log = logger || (() => {});
  const found = [];
  const errors = [];
  const client = new ImapFlow({
    host, port: Number(port) || 993, secure: true,
    auth: { user, pass: String(pass).replace(/\s/g, '') },
    logger: false,
  });
  try {
    await client.connect();
  } catch (e) {
    return { found, errors: ['Polaczenie IMAP nieudane: ' + e.message.split('\n')[0] + ' (zly host/login/haslo? Dla Gmaila potrzebne HASLO APLIKACJI, nie zwykle haslo.)'] };
  }
  const folders = ['INBOX'];
  try {
    const list = await client.list();
    if (list.some(f => /spam/i.test(f.path))) folders.push(list.find(f => /spam/i.test(f.path)).path);
  } catch {}
  for (const folder of folders) {
    try {
      await client.mailboxOpen(folder);
      const uids = await client.search({ since, or: [{ subject: code }, { body: code }] });
      log(`   ${folder}: pasujacych wiadomosci: ${uids.length}`);
      for (const uid of uids) {
        const msg = await client.fetchOne(String(uid), { envelope: true });
        found.push({
          uid, folder,
          from: ((msg.envelope.from || [])[0] || {}).address || '?',
          fromDomain: senderDomain(msg),
          subject: msg.envelope.subject || '(bez tematu)',
          date: msg.envelope.date,
        });
      }
    } catch (e) { errors.push(folder + ': ' + e.message.split('\n')[0]); }
  }
  try { await client.logout(); } catch {}
  return { found, errors };
}

if (require.main === module) {
  (async () => {
    const ARGS = process.argv.slice(2);
    const code = ((ARGS.find(a => a.startsWith('--code=')) || '=').split('=')[1] || '').trim();
    const sinceMin = parseInt(((ARGS.find(a => a.startsWith('--since-min=')) || '=').split('=')[1] || ''), 10) || 0;
    if (!code) { console.error('Uzycie: node imap-check.js --code=TEST-xxx [--since-min=30]'); process.exit(1); }
    const { cfg, missing } = loadEnv();
    if (missing) { console.error('Brak .env z danymi skrzynki. Skopiuj .env.example -> .env i uzupelnij (patrz instrukcja w pliku).'); process.exit(1); }
    const since = sinceMin ? new Date(Date.now() - sinceMin * 60000) : new Date(new Date().setHours(0, 0, 0, 0));
    console.log(`Szukam "${code}" na ${cfg.IMAP_USER} (od ${since.toLocaleString('pl-PL')})...`);
    const { found, errors } = await findCode({ ...cfg, code, since, logger: console.log });
    errors.forEach(e => console.log('! ' + e));
    if (!found.length) console.log('✉️  NIE ZNALEZIONO (sprawdz tez SPAM recznie - IMAP nie zawsze go widzi).');
    found.forEach(f => console.log(`✉️  DOSZEDL [${f.folder}] od ${f.from} | temat: ${f.subject} | ${f.date}`));
  })().catch(e => { console.error('FATAL: ' + e.message); process.exit(2); });
}

module.exports = { findCode, loadEnv };
