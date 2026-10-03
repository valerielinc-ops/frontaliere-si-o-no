#!/usr/bin/env node
/**
 * End-to-end check of the portal runner on a LOCAL fake portal: no employer,
 * no Codex, no Firestore. Run by assisted-application-portal-e2e.yml when the
 * runner changes, and by hand:
 *
 *   node scripts/assisted-application/portal-e2e.mjs
 *   (PLAYWRIGHT_CHROMIUM_PATH=<binary> to use a local Chromium build)
 *
 * posting → sign-in page → "Konto erstellen" → register (two passwords, the
 * required consent, a newsletter box left alone) → "check your e-mail" →
 * activation link from the inbox → sign-in → form (CV upload) → submit →
 * confirmation. Three runs: a dry run (stops before creating the account),
 * the first real run (creates, verifies, applies), a second one (signs in).
 * The same for Coop's way in (2026-10-02): its career page, the Prospective.ch
 * redirect, SuccessFactors' registration with its privacy-statement dialog.
 */
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchChromium } from '../lib/ensure-chromium.mjs';
import { submitViaPortal } from './lib/portal/portal.mjs';
import { aiSnapshot, runAction } from './lib/portal/agent.mjs';
import { extractFields } from './lib/portal/fields.mjs';
import { applyActions } from './lib/portal/fill.mjs';
import { normalizeLabel } from './lib/portal/knowledge.mjs';

const ALIAS = 'c-abcdefghjk@candidature.frontaliereticino.ch';
// The tenant id in the address names no company: the posting is checked on the form.
const SF_JOB = '/sf/career?company=tenant1000103&career_ns=job_application&career_job_req_id=170044';
// SuccessFactors' password policy (8–18 characters) follows its host name.
const sfOrigin = (server) => `http://career2.successfactors.localhost:${server.address().port}`;

function fakePortal() {
  const state = { accounts: new Map(), verified: new Set(), sessions: new Set(), applications: [], widgetApplications: [], summarySubmissions: 0, summaryCv: [], newsletter: false, pending: null, refuseNextRegistration: false };
  // Coop, 2026-10-02: Prospective.ch's career page in front of SAP SuccessFactors.
  const coop = { later: 0, accounts: new Map(), sessions: new Set(), applications: [], jobAbo: false, privacyAccepted: 0, refused: [] };
  const page = (title, body) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${title}</title></head><body><main>${body}</main></body></html>`;
  const form = (action, inner, multipart = false) => `<form method="post" action="${action}"${multipart ? ' enctype="multipart/form-data"' : ''}>${inner}</form>`;
  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
  });
  const sessionOf = (req) => /sid=([a-z0-9]+)/.exec(req.headers.cookie || '')?.[1];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://portal.test');
    const send = (html) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); };
    const redirect = (to, headers = {}) => { res.writeHead(303, { location: to, ...headers }); res.end(); };
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /job') return send(page('Pflegefachperson', '<h1>Pflegefachperson 80%</h1><a href="/login">Jetzt bewerben</a>'));
    // jobs.coopjobs.ch as seen on 2026-10-02: «Später bewerben» (a bookmark by
    // e-mail) comes first, a Usercentrics banner in a shadow root covers the
    // page, «Jetzt bewerben» opens the ATS redirect in a new tab.
    if (route === 'GET /coop-job') {
      return send(page('Coop: Bäcker:in - Konditor:in', `<header><a role="button" tabindex="0" href="/coop-later">Später bewerben</a></header>
        <h1>Bäcker:in - Konditor:in (Schwerpunkt Bäckerei)</h1><p>Coop Genossenschaft, Rickenbach</p>
        <a class="main-btn apply" target="_blank" href="/ohws/redirect/20d53107-db26-4a35-8f4c-b4d15bb4bb31/ats/">Jetzt bewerben</a>
        <div id="usercentrics-root"></div><script>
          const host = document.getElementById('usercentrics-root');
          const root = host.attachShadow({ mode: 'open' });
          root.innerHTML = '<div style="position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.3)"><div role="dialog" aria-label="Privatsphäre"><button type="button">Einstellungen verwalten</button><button type="button" id="all">Alle akzeptieren</button></div></div>';
          root.getElementById('all').addEventListener('click', () => host.remove());
        </script>`));
    }
    if (route === 'GET /coop-later') {
      coop.later += 1;
      return send(page('Später bewerben', '<p>Wir senden dir den Link per E-Mail.</p>'));
    }
    // To another host, as Coop's redirect does: SuccessFactors' own (a *.localhost name is the loopback for Chrome).
    if (url.pathname.startsWith('/ohws/redirect/')) return redirect(`${sfOrigin(server)}${SF_JOB}`);
    if (route === 'GET /sf/career') {
      if (coop.sessions.has(sessionOf(req))) {
        return send(page('Karrierechancen: Bewerbung', `<h1>Coop</h1><h2>Bäcker:in - Konditor:in (Schwerpunkt Bäckerei)</h2>${form('/sf/apply', '<label for="v">Vorname: *</label><input id="v" name="first" required><label for="n">Nachname: *</label><input id="n" name="last" required><label for="m">E-Mail-Adresse: *</label><input id="m" type="email" name="mail" required><label for="cv">Lebenslauf: *</label><input id="cv" type="file" name="cv" required><button type="button">Entwurf speichern</button><button type="submit">Bewerben</button>', true)}`));
      }
      return send(page('Karrierechancen: Anmelden', `<p>Haben Sie schon ein Konto? Mit bestehendem Profil anmelden und bewerben</p>${form('/sf/login', '<label for="u">E-Mail-Adresse:*</label><input id="u" type="text" name="username" required><label for="p">Kennwort:*</label><input id="p" type="password" name="password" required><button type="submit">Anmelden</button>')}<p><a href="/sf/register">Noch kein Profil? Hier registrieren</a> und direkt bewerben</p>`));
    }
    if (route === 'POST /sf/login') {
      const body = new URLSearchParams(await readBody(req));
      if (coop.accounts.get(body.get('username')) !== body.get('password')) return send(page('Karrierechancen: Anmelden', '<p role="alert">Ungültige Anmeldedaten</p>'));
      const sid = Math.random().toString(36).slice(2);
      coop.sessions.add(sid);
      return redirect(SF_JOB, { 'set-cookie': `sid=${sid}; Path=/` });
    }
    // «Konto anlegen»: the privacy statement opens only for a chosen country, in a dialog.
    if (route === 'GET /sf/register') {
      return send(page('Karrierechancen: Konto anlegen', `${form('/sf/register', `<label for="e1">E-Mail-Adresse: *</label><input id="e1" type="text" name="email" required>
        <label for="e2">E-Mail-Adresse erneut eingeben: *</label><input id="e2" type="text" name="email2" required>
        <label for="p1">Wähle ein Kennwort: *</label><input id="p1" type="password" name="p1" required>
        <label for="p2">Kennwort erneut eingeben: *</label><input id="p2" type="password" name="p2" required>
        <label for="f">Vorname: *</label><input id="f" name="first" required><label for="l">Nachname: *</label><input id="l" name="last" required>
        <label for="c">Land/Region des Wohnorts:*</label><select id="c" name="country" required><option value="">- Bitte auswählen -</option><option value="CH">Schweiz</option><option value="IT">Italien</option></select>
        <label for="abo">Job-Abo</label><input type="checkbox" id="abo" name="abo">
        <input type="hidden" id="dpcs" name="dpcs" value="">
        <label for="dataPrivacyId">Datenschutzerklärung:*</label><a id="dataPrivacyId" role="button" tabindex="0" aria-haspopup="dialog">Datenschutzerklärung lesen und akzeptieren.</a>
        <button type="submit">Konto anlegen</button>`)}
        <div role="dialog" id="dpcsDialog" hidden><p>Datenschutzerklärung für Stellenbewerber:innen</p><button type="button" id="ok">Akzeptieren</button><button type="button" id="no">Ablehnen</button></div>
        <script>
          const dialog = document.getElementById('dpcsDialog');
          // As on Coop's SuccessFactors (run 37056165460): the password repeat checks
          // itself on blur, and a click on the statement's link meanwhile is lost.
          let checking = false;
          document.getElementById('p2').addEventListener('blur', () => {
            checking = true;
            fetch('/sf/pwd-policy', { method: 'POST' }).finally(() => { checking = false; });
          });
          document.getElementById('dataPrivacyId').addEventListener('click', () => { if (!checking && document.getElementById('c').value) dialog.hidden = false; });
          document.getElementById('ok').addEventListener('click', () => { document.getElementById('dpcs').value = '1'; dialog.hidden = true; });
          document.getElementById('no').addEventListener('click', () => { dialog.hidden = true; });
        </script>`));
    }
    if (route === 'POST /sf/pwd-policy') {
      await new Promise((done) => setTimeout(done, 1200));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (route === 'POST /sf/register') {
      const body = new URLSearchParams(await readBody(req));
      const password = String(body.get('p1') || '');
      const problems = [
        body.get('email') !== body.get('email2') && 'email',
        (password !== body.get('p2') || password.length < 8 || password.length > 18 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9\W]/.test(password)) && 'password',
        (!body.get('first') || !body.get('last')) && 'name',
        !body.get('country') && 'country',
        body.get('dpcs') !== '1' && 'dpcs',
      ].filter(Boolean);
      if (body.get('abo')) coop.jobAbo = true;
      if (problems.length) {
        coop.refused.push(problems.join(','));
        return send(page('Karrierechancen: Konto anlegen', `<p role="alert">${problems.join(', ')} ist erforderlich</p>`));
      }
      coop.privacyAccepted += 1;
      coop.accounts.set(body.get('email'), password);
      const sid = Math.random().toString(36).slice(2);
      coop.sessions.add(sid);
      return redirect(SF_JOB, { 'set-cookie': `sid=${sid}; Path=/` });
    }
    if (route === 'POST /sf/apply') {
      const raw = await readBody(req);
      coop.applications.push({ hasCv: /filename="CV_/.test(raw), first: /name="first"\r\n\r\n([^\r]*)/.exec(raw)?.[1] || '' });
      return send(page('Karrierechancen', '<h1>Vielen Dank für deine Bewerbung</h1>'));
    }
    if (route === 'GET /login') {
      if (state.sessions.has(sessionOf(req))) return redirect('/apply');
      return send(page('Anmelden', `${form('/login', '<label for="e">E-Mail-Adresse</label><input id="e" type="email" name="email" required><label for="p">Kennwort</label><input id="p" type="password" name="password" required><button type="submit">Anmelden</button>')}<a href="/register">Konto erstellen</a>`));
    }
    if (route === 'POST /login') {
      const body = new URLSearchParams(await readBody(req));
      const email = body.get('email');
      if (state.accounts.get(email) !== body.get('password')) return send(page('Anmelden', '<p role="alert">Falsches Kennwort</p>'));
      if (!state.verified.has(email)) return send(page('Bestätigung', '<p>Bitte bestätigen Sie zuerst Ihre E-Mail-Adresse.</p>'));
      const sid = Math.random().toString(36).slice(2);
      state.sessions.add(sid);
      return redirect('/apply', { 'set-cookie': `sid=${sid}; Path=/` });
    }
    if (route === 'GET /register') {
      return send(page('Registrieren', form('/register', '<label for="e">E-Mail-Adresse</label><input id="e" type="email" name="email" required><label for="p1">Kennwort</label><input id="p1" type="password" name="p1" required><label for="p2">Kennwort bestätigen</label><input id="p2" type="password" name="p2" required><label><input type="checkbox" name="privacy" required> Ich akzeptiere die Datenschutzerklärung *</label><label><input type="checkbox" name="news"> Newsletter abonnieren</label><button type="submit">Konto erstellen</button>')));
    }
    if (route === 'POST /register') {
      const body = new URLSearchParams(await readBody(req));
      if (state.refuseNextRegistration || body.get('p1') !== body.get('p2') || !body.get('privacy') || String(body.get('p1')).length < 12) {
        state.refuseNextRegistration = false;
        return send(page('Registrieren', '<p role="alert">Ungültig</p>'));
      }
      if (body.get('news')) state.newsletter = true;
      state.accounts.set(body.get('email'), body.get('p1'));
      state.pending = { email: body.get('email'), token: `tok${Math.random().toString(36).slice(2)}` };
      return send(page('E-Mail gesendet', '<p>Wir haben Ihnen eine E-Mail gesendet. Bitte bestätigen Sie Ihre E-Mail-Adresse über den Link.</p>'));
    }
    if (route === 'GET /activate') {
      if (!state.pending || url.searchParams.get('t') !== state.pending.token) return send(page('Fehler', '<p>Ungültiger Link</p>'));
      state.verified.add(state.pending.email);
      return redirect('/login');
    }
    if (route === 'GET /apply') {
      if (!state.sessions.has(sessionOf(req))) return redirect('/login');
      return send(page('Bewerbung', form('/apply', '<label for="v">Vorname *</label><input id="v" name="first" required><label for="n">Nachname *</label><input id="n" name="last" required><label for="m">E-Mail *</label><input id="m" type="email" name="mail" required><label for="cv">Lebenslauf *</label><input id="cv" type="file" name="cv" required><button type="submit">Bewerbung absenden</button>', true)));
    }
    if (route === 'POST /apply') {
      const raw = await readBody(req);
      state.applications.push({ hasCv: /filename="CV_/.test(raw), first: /name="first"\r\n\r\n([^\r]*)/.exec(raw)?.[1] || '' });
      return send(page('Danke', '<h1>Vielen Dank für Ihre Bewerbung</h1>'));
    }
    // A form with a custom calendar the filler cannot read (JOIN's "Quando sei
    // nato?"): the send button stays disabled until a day is chosen.
    if (route === 'GET /widget-job') return send(page('Pflegefachperson', '<h1>Pflegefachperson 60%</h1><a href="/widget">Jetzt bewerben</a>'));
    if (route === 'GET /widget') {
      const days = ['11', '12'].map((day) => `<div role="button" tabindex="0" aria-label="Choose ${day} May 1990" data-d="1990-05-${day}">${day}</div>`).join('');
      return send(page('Bewerbung', `${form('/widget', `<label for="v">Vorname *</label><input id="v" name="first" required><label for="m">E-Mail *</label><input id="m" type="email" name="mail" required><label for="cv">Lebenslauf *</label><input id="cv" type="file" name="cv" required><h2>Geburtsdatum *</h2><input type="hidden" id="dob" name="dob"><div role="group" aria-label="Mai 1990">${days}</div><button type="submit" id="send" disabled>Bewerbung absenden</button>`, true)}
        <script>document.querySelectorAll('[data-d]').forEach((day) => day.addEventListener('click', () => { document.getElementById('dob').value = day.dataset.d; day.setAttribute('aria-pressed', 'true'); document.getElementById('send').disabled = false; }));</script>`));
    }
    // A summary page whose send button has an unusual name, and a dead end (self-correction).
    if (route === 'GET /summary') {
      return send(page('Zusammenfassung', `<h1>Ihre Bewerbung</h1><p>Bitte prüfen Sie Ihre Angaben.</p>${form('/summary', '<button type="submit">Abschliessen und übermitteln</button>')}`));
    }
    if (route === 'POST /summary') {
      state.summarySubmissions += 1;
      return send(page('Danke', '<h1>Vielen Dank für Ihre Bewerbung</h1>'));
    }
    // The same unusual send button under a required CV: the upload counts as filled.
    if (route === 'GET /summary-cv') {
      return send(page('Zusammenfassung', `<h1>Ihre Bewerbung</h1>${form('/summary-cv', '<label for="cv">Lebenslauf *</label><input id="cv" type="file" name="cv" required><button type="submit">Abschliessen und übermitteln</button>', true)}`));
    }
    if (route === 'POST /summary-cv') {
      const raw = await readBody(req);
      state.summaryCv.push({ hasCv: /filename="CV_/.test(raw) });
      return send(page('Danke', '<h1>Vielen Dank für Ihre Bewerbung</h1>'));
    }
    if (route === 'GET /dead-end') return send(page('Bewerbung', '<h1>Bewerbung</h1><p>Diese Seite ist leer.</p>'));
    // JOIN 2026-10-01: an invisible reCAPTCHA scores the browser; the send click does nothing visible.
    if (route === 'GET /antibot') {
      return send(page('Bewerbung', `<h1>Ihre Bewerbung</h1><div class="grecaptcha-badge" style="width:256px;height:60px"></div>${form('/antibot', '<button type="submit">Bewerbung absenden</button>').replace('<form ', '<form onsubmit="return false" ')}`));
    }
    // Lever, TSMG 2026-10-01: the send click serves an hCaptcha challenge nobody passes; the form stays as it was.
    if (route === 'GET /hchallenge') {
      return send(page('Application', `<h1>Submit your application</h1>${form('/hchallenge', '<button type="submit">Submit application</button>').replace('<form ', '<form onsubmit="fetch(\'https://api.hcaptcha.com/getcaptcha/e2e-site\', { method: \'POST\' }).catch(() => {}); return false" ')}`));
    }
    // JOIN run 36846326334: the portal answers the send click with its own refusal toast.
    if (route === 'GET /refused') {
      return send(page('Candidatura', `<h1>La tua candidatura</h1><div class="grecaptcha-badge" style="width:256px;height:60px"></div><div id="toast" role="status"></div>${form('/refused', '<button type="submit">Conferma e applica</button>').replace('<form ', '<form onsubmit="document.getElementById(\'toast\').textContent = \'Non siamo riusciti a inviare la tua candidatura. Riprova.\'; return false" ')}`));
    }
    // Client validation and a JSON error with HTTP 200 were invisible to the old diagnostics.
    if (route === 'GET /diagnostic-refused') {
      return send(page('Candidatura', `<h1>La tua candidatura</h1><input id="profile" type="url" aria-label="LinkedIn" hidden><div id="toast" role="status"></div><button onclick="submitTest()">Conferma e applica</button><script>
        async function submitTest() {
          document.getElementById('profile').value = 'invalid-url';
          const result = await fetch('/diagnostic-error', {method:'POST'}).then(response => response.json());
          console.error(result.errors[0].message + ' token=private-test-token');
          setTimeout(() => { throw new Error('client_submit_validation'); }, 0);
          document.getElementById('toast').textContent = 'Non siamo riusciti a inviare la tua candidatura. Riprova.';
        }
      </script>`));
    }
    if (route === 'POST /diagnostic-error') {
      const body = JSON.stringify({ errors: [{ field: 'linkedin', code: 'INVALID_URL', message: 'Profile URL invalid' }] });
      // JOIN returns chunked GraphQL errors: no declared Content-Length.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
      return res.end(body);
    }
    // The refusal shown on an error page the portal moves to (review of #10741).
    if (route === 'GET /refused-moved') {
      return send(page('Candidatura', `<h1>La tua candidatura</h1>${form('/refused-moved', '<button type="submit">Conferma e applica</button>')}`));
    }
    if (route === 'POST /refused-moved') return redirect('/refused-moved/error');
    if (route === 'GET /refused-moved/error') return send(page('Errore', '<p role="alert">Non siamo riusciti a inviare la tua candidatura. Riprova.</p>'));
    if (route === 'POST /widget') {
      const raw = await readBody(req);
      state.widgetApplications.push({ hasCv: /filename="CV_/.test(raw), dob: /name="dob"\r\n\r\n([^\r]*)/.exec(raw)?.[1] || '' });
      return send(page('Danke', '<h1>Vielen Dank für Ihre Bewerbung</h1>'));
    }
    res.writeHead(404);
    res.end();
  });
  return { server, state, coop };
}

/**
 * Agent stand-in (agent.mjs): clicks the birth date's day on the snapshot's
 * ref, then says the page is done. The answer comes from the profile when the
 * candidate data has one; without it, it is invented ("rule") and the code
 * guard must turn it into a question for the candidate.
 */
let agentTurns = 0;
function fakeAgent(prompt) {
  agentTurns += 1;
  const snapshot = prompt.slice(prompt.indexOf('Page snapshot:'));
  const { agentPage } = JSON.parse(prompt.slice(prompt.indexOf('{"agentPage"'), prompt.indexOf('\n\nPage snapshot:')));
  const turn = (status, actions = [], extra = {}) => ({ status, reason: '', advanceRef: '', submitRef: '', actions, questions: [], ...extra });
  // The last page's send button with an unusual name: named, never pressed (self-correction, level 1).
  const send = /button "Abschliessen und übermitteln" \[ref=(\w+)\]/.exec(snapshot);
  if (send) return turn('done', [], { submitRef: send[1] });
  if (agentPage.history.length) return turn('done');
  const day = /button "Choose 12 May 1990" \[ref=(\w+)\]/.exec(snapshot);
  const source = /"dateOfBirth":"\d/.test(prompt) ? 'profile' : 'rule';
  return turn('act', day ? [{ ref: day[1], action: 'click', value: '', document: 'none', question: 'Geburtsdatum *', answer: '1990-05-12', source }] : []);
}

/** Planner stand-in: answers by label, as the real planner does for these fields. */
async function fakeCodex({ prompt }) {
  if (prompt.includes('{"agentPage"')) return fakeAgent(prompt);
  const form = JSON.parse(prompt.slice(prompt.lastIndexOf('{"form"'), prompt.lastIndexOf('\n\nReturn exactly'))).form;
  const actions = form.fields.map((field) => {
    const act = (action, value = '', extra = {}) => ({ fieldId: field.id, action, value, document: 'none', source: 'identity', ...extra });
    if (/e-?mail/i.test(field.label)) return act('fill', ALIAS);
    if (/datenschutz/i.test(field.label)) return act('check', '', { source: 'consent' });
    if (/vorname/i.test(field.label)) return act('fill', 'Luca');
    if (/land\/region/i.test(field.label)) return act('select', 'Italien', { source: 'profile' });
    if (/nachname/i.test(field.label)) return act('fill', 'Bianchi');
    if (field.kind === 'file') return act('upload', '', { document: 'cv', source: 'documents' });
    return act('skip', '', { source: 'rule' });
  });
  return { actions, missingRequired: [] };
}

async function main() {
  const { server, state, coop } = fakePortal();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const saved = new Map();
  const accounts = {
    async load(host) { return saved.get(host) || null; },
    async save(host, { email, password }) { saved.set(host, { email, password, createdAt: Date.now(), verifiedAt: null }); },
    async mark(host, patch) { saved.set(host, { ...saved.get(host), ...patch }); },
    async discard(host) { saved.delete(host); },
    // The e-mail the portal would send to the alias, as the inbound handler stores it.
    async waitForVerification() { return state.pending ? { url: `${base}/activate?t=${state.pending.token}`, code: '' } : null; },
  };
  const dir = await mkdtemp(path.join(tmpdir(), 'aa-portal-e2e-'));
  const files = { cv: path.join(dir, 'CV_Luca_Bianchi.pdf'), cover_letter: path.join(dir, 'Anschreiben_Luca_Bianchi.pdf') };
  await writeFile(files.cv, '%PDF-1.4\n%%EOF\n');
  await writeFile(files.cover_letter, '%PDF-1.4\n%%EOF\n');
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
  const run = (extra = {}) => submitViaPortal({
    applyUrl: `${base}/job`,
    language: 'de',
    candidateLocale: 'it',
    candidate: { identity: { email: ALIAS } },
    files,
    codex: fakeCodex,
    accounts,
    launch: () => launchChromium({ headless: true, executablePath }),
    ...extra,
  });

  // hCaptcha's own host answered locally: the test never calls the real service.
  const launchWithLocalHcaptcha = async () => {
    const browser = await launchChromium({ headless: true, executablePath });
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (options) => {
      const context = await newContext(options);
      await context.route('https://api.hcaptcha.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":false}' }));
      return context;
    };
    return browser;
  };

  const checks = [];
  const check = (name, ok) => { checks.push({ name, ok }); console.log(`${ok ? '✓' : '✗'} ${name}`); };
  try {
    const dry = await run({ dryRun: true });
    check('a dry run stops before creating the account', dry.event.type === 'dry_run_ready' && dry.event.stage === 'account' && state.accounts.size === 0);
    // The portal refuses the registration once: no account is kept, so the next run creates it again.
    state.refuseNextRegistration = true;
    const refused = await run();
    check('a refused registration hands off and keeps no account', refused.event.type === 'submit_handoff' && refused.event.reason === 'account_create_refused' && !saved.has('127.0.0.1') && state.accounts.size === 0);
    const first = await run();
    check('the first run creates the account on the alias, verifies it and applies', first.event.type === 'submit_succeeded' && state.accounts.has(ALIAS) && state.verified.has(ALIAS));
    check('the password is stored and the account marked verified', Boolean(saved.get('127.0.0.1')?.password) && Boolean(saved.get('127.0.0.1')?.verifiedAt));
    const again = await run();
    const auth = again.evidence.steps.filter((step) => step.auth).map((step) => step.auth.kind);
    check('a later run signs in with the stored account', again.event.type === 'submit_succeeded' && auth.join(',') === 'sign_in' && state.accounts.size === 1);
    check('both applications carry the CV and the name', state.applications.length === 2 && state.applications.every((item) => item.hasCv && item.first === 'Luca'));
    check('the newsletter box is left alone', !state.newsletter);
    // The agentic fallback on a custom calendar (Playwright's snapshot refs, a real browser).
    const unknown = await run({ applyUrl: `${base}/widget-job`, candidate: { identity: { email: ALIAS }, profile: {}, answers: {}, portalQuestionsAnswered: [] } });
    const asked = unknown.event.questions || [];
    check('without the birth date the agent asks the candidate and sends nothing', unknown.event.type === 'submit_needs_candidate'
      && asked.length === 1 && asked[0].question === 'Geburtsdatum' && asked[0].type === 'date' && state.widgetApplications.length === 0);
    // Review of #10707: Codex failing inside the fallback ends in the owner's handoff, not a failed run.
    const failing = async (request) => {
      if (request.prompt.includes('{"agentPage"')) throw new Error('timeout');
      return fakeCodex(request);
    };
    const broken = await run({ applyUrl: `${base}/widget-job`, codex: failing, candidate: { identity: { email: ALIAS }, profile: { dateOfBirth: '12.05.1990' }, answers: {}, portalQuestionsAnswered: [] } });
    check('a Codex failure in the fallback hands the order to the owner', broken.event.type === 'submit_handoff'
      && broken.event.reason === 'portal_needs_candidate' && state.widgetApplications.length === 0);
    const widget = await run({ applyUrl: `${base}/widget-job`, candidate: { identity: { email: ALIAS }, profile: { dateOfBirth: '12.05.1990' }, answers: {}, portalQuestionsAnswered: [] } });
    const agentSteps = widget.evidence.steps.filter((step) => step.agent);
    // Second review of #10707: a select picks only the exact option ("1990" is not "1990s").
    const listPage = await (await launchChromium({ headless: true, executablePath })).newPage();
    await listPage.setContent('<input role="combobox" aria-label="Jahr" aria-controls="years"><div role="listbox" id="years"><div role="option">1990s</div></div>');
    const yearRef = /combobox "Jahr" \[ref=(\w+)\]/.exec((await aiSnapshot(listPage)) || '')?.[1];
    const near = await runAction(listPage, { ref: yearRef, action: 'select', value: '1990' });
    check('a select never takes a near option', near.ok === false && near.error === 'option_not_found');
    await listPage.context().browser().close();
    // Review of #10822: visible unrelated year/month lists must not shift JOIN's
    // selections away from the popups controlled by the date comboboxes.
    const dateBrowser = await launchChromium({ headless: true, executablePath });
    const datePage = await dateBrowser.newPage();
    const unrelatedOptions = Array.from({ length: 12 }, (_, index) => `<div role="option">Unrelated ${index + 1}</div>`).join('');
    const unrelatedYearOptions = '<div role="option">2025</div>';
    const monthOptions = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
      .map((label, index) => `<div role="option" data-month="${index + 1}">${label}</div>`).join('');
    await datePage.setContent(`<div data-scope="date-picker" data-part="root" aria-label="Birth date">
      <input id="date-year" role="combobox" aria-controls="date-years" value="">
      <input id="date-month" role="combobox" aria-controls="date-months" value="">
      <div role="listbox" id="unrelated-options">${unrelatedOptions}</div>
      <div role="listbox" id="date-years"><div role="option">2025</div></div>
      <div role="listbox" id="unrelated-years">${unrelatedYearOptions}</div>
      <div role="listbox" id="date-months" style="display:none">${monthOptions}</div>
      <div role="listbox" id="unrelated-months">${monthOptions}</div>
      <div data-part="table"><div data-part="table-cell-trigger" role="button" data-value="2025-05-12" style="display:none">12</div></div>
    </div><script>
      const year = document.getElementById('date-year');
      const month = document.getElementById('date-month');
      const months = document.getElementById('date-months');
      const day = document.querySelector('[data-value="2025-05-12"]');
      month.addEventListener('keydown', (event) => { if (event.key === 'ArrowDown') months.style.display = ''; });
      document.querySelector('#date-years [role="option"]').addEventListener('click', () => { year.value = '2025'; });
      months.querySelectorAll('[role="option"]').forEach((option) => option.addEventListener('click', () => { month.value = option.dataset.month; day.style.display = ''; }));
      day.addEventListener('click', () => day.setAttribute('data-selected', ''));
    </script>`);
    const dateSnapshot = await extractFields(datePage);
    const dateField = dateSnapshot.fields.find((field) => field.kind === 'date');
    const dateResult = await applyActions(datePage, dateSnapshot.fields, [
      { fieldId: dateField?.id, action: 'fill', value: '2025-05-12' },
    ], {}, { pause: async () => {} });
    const pickedDate = await datePage.locator('[data-part="table-cell-trigger"][data-selected]').getAttribute('data-value').catch(() => '');
    const pickedYear = await datePage.locator('#date-year').inputValue();
    const pickedMonth = await datePage.locator('#date-month').inputValue();
    check('unrelated visible year and month lists cannot shift the JOIN picker', dateResult[0]?.ok === true
      && pickedDate === '2025-05-12' && pickedYear === '2025' && pickedMonth === '5');
    await dateBrowser.close();

    const unownedBrowser = await launchChromium({ headless: true, executablePath });
    const unownedPage = await unownedBrowser.newPage();
    await unownedPage.setContent(`<div data-scope="date-picker" data-part="root" aria-label="Birth date">
      <input id="unowned-year" role="combobox" value="">
      <input id="unowned-month" role="combobox" value="">
      <div role="listbox" id="unrelated-years"><div role="option">2025</div></div>
      <div role="listbox" id="unrelated-months">${monthOptions}</div>
      <div data-part="table"><div data-part="table-cell-trigger" role="button" data-value="2025-05-12" style="display:none">12</div></div>
    </div><script>
      window.unrelatedClicks = 0;
      document.querySelectorAll('#unrelated-years [role="option"], #unrelated-months [role="option"]')
        .forEach((option) => option.addEventListener('click', () => { window.unrelatedClicks += 1; }));
    </script>`);
    const unownedSnapshot = await extractFields(unownedPage);
    const unownedField = unownedSnapshot.fields.find((field) => field.kind === 'date');
    const unownedResult = await applyActions(unownedPage, unownedSnapshot.fields, [
      { fieldId: unownedField?.id, action: 'fill', value: '2025-05-12' },
    ], {}, { pause: async () => {} });
    const unrelatedClicks = await unownedPage.evaluate(() => window.unrelatedClicks);
    check('an unowned JOIN popup fails closed without clicking an unrelated list', unownedResult[0]?.ok === false && unrelatedClicks === 0);
    await unownedBrowser.close();
    // career-ops apply.md: company and role on the form match the posting, or stop.
    const elsewhere = await run({ applyUrl: `${base}/widget-job`, job: { company: 'Muster Elektro AG', title: 'Elektroinstallateur EFZ' }, candidate: { identity: { email: ALIAS }, profile: { dateOfBirth: '12.05.1990' }, answers: {}, portalQuestionsAnswered: [] } });
    check('a form for another job is never filled', elsewhere.event.type === 'submit_handoff' && elsewhere.event.reason === 'posting_mismatch' && state.widgetApplications.length === 1);
    // career-ops "verify each selection": a click that does not take is a failure, not an answer.
    const comboPage = await (await launchChromium({ headless: true, executablePath })).newPage();
    await comboPage.setContent(`<label for="good">Land</label><div><input id="good" role="combobox" aria-controls="gl"><span id="gv"></span><div role="listbox" id="gl"><div role="option" onclick="document.getElementById('gv').textContent='Schweiz'; this.parentElement.remove()">Schweiz</div></div></div>
      <label for="bad">Nationalität</label><div><input id="bad" role="combobox" aria-controls="bl"><div role="listbox" id="bl"><div role="option" onclick="document.getElementById('bad').value=''">Italien</div></div></div>
      <label for="near">Wohnland</label><div><input id="near" role="combobox" aria-controls="nl"><span id="nv"></span><div role="listbox" id="nl"><div role="option" onclick="document.getElementById('nv').textContent='Italy'">Italy</div></div></div>`);
    const combo = await extractFields(comboPage);
    const byLabel = (label) => combo.fields.find((field) => field.label === label)?.id;
    const picked = await applyActions(comboPage, combo.fields, [
      { fieldId: byLabel('Land'), action: 'select', value: 'Schweiz' },
      { fieldId: byLabel('Nationalität'), action: 'select', value: 'Italien' },
      // Review of #10715: "IT" never picks the only option "Italy".
      { fieldId: byLabel('Wohnland'), action: 'select', value: 'IT' },
    ], {}, { pause: async () => {} });
    check('a choice is verified on the page', picked[0]?.ok === true && picked[1]?.ok === false && picked[1]?.error === 'choice_not_registered'
      && picked[2]?.ok === false && picked[2]?.error === 'option_not_found');
    await comboPage.context().browser().close();
    // Self-correction, levels 1 and 2: the agent names an unusual send button,
    // the runner presses it behind the guard, the portal's memory learns it.
    const portalMemory = new Map();
    const knowledge = {
      async load(host) { return portalMemory.get(host) || { finalButtons: [], nextButtons: [] }; },
      async learn(host, { finalButton = null, nextButtons = [] }) {
        const current = portalMemory.get(host) || { finalButtons: [], nextButtons: [] };
        const clean = (button) => ({ path: button.path, label: normalizeLabel(button.label) });
        portalMemory.set(host, {
          finalButtons: [...(finalButton ? [clean(finalButton)] : []), ...current.finalButtons],
          nextButtons: [...nextButtons.map(clean), ...current.nextButtons],
        });
      },
    };
    const turnsBefore = agentTurns;
    const named = await run({ applyUrl: `${base}/summary`, knowledge });
    check('the agent names an unusual send button and the runner presses it', named.event.type === 'submit_succeeded'
      && named.evidence.finalButton?.by === 'agent' && state.summarySubmissions === 1 && agentTurns > turnsBefore);
    const turnsLearned = agentTurns;
    const taught = await run({ applyUrl: `${base}/summary`, knowledge });
    check('the next run presses the learned button without the agent', taught.event.type === 'submit_succeeded'
      && taught.evidence.finalButton?.by === 'runner' && state.summarySubmissions === 2 && agentTurns === turnsLearned);
    const withCv = await run({ applyUrl: `${base}/summary-cv` });
    check('the agent’s send button is pressed under a required CV the runner attached', withCv.event.type === 'submit_succeeded'
      && withCv.evidence.finalButton?.by === 'agent' && state.summaryCv.length === 1 && state.summaryCv[0].hasCv);
    // Level 3: a page the runner cannot get through leaves an anonymous stop report.
    const dead = await run({ applyUrl: `${base}/dead-end` });
    check('a dead end leaves a stop report for the fix issue', dead.event.type === 'submit_handoff'
      && dead.evidence.stopReport?.path === '/dead-end' && dead.evidence.stopReport?.host === '127.0.0.1');
    // The send click leaves the page as it was, behind an invisible reCAPTCHA: Valerie is told it most likely did not arrive.
    const silent = await run({ applyUrl: `${base}/antibot` });
    check('a send the portal silently drops is reported as a likely anti-bot refusal', silent.event.type === 'submit_failed'
      && silent.event.error === 'portal_antibot_ambiguous' && silent.evidence.antibot === true);
    // A challenge served after the click and never passed: the application never left, Valerie completes it.
    const challenged = await run({ applyUrl: `${base}/hchallenge`, launch: launchWithLocalHcaptcha });
    check('a CAPTCHA served after the send click and never passed is a CAPTCHA stop, not an unknown outcome', challenged.event.type === 'submit_handoff'
      && challenged.event.reason === 'captcha' && challenged.evidence.challengeAfterClick === true);
    // The portal says it did not send: not ambiguous, and the browser used is in the evidence.
    const toast = await run({ applyUrl: `${base}/refused` });
    check('a send the portal refuses in words is a refusal, not an ambiguity', toast.event.type === 'submit_failed'
      && toast.event.error === 'portal_refused' && toast.evidence.antibot === true
      && typeof toast.evidence.browser?.userAgent === 'string' && !/headless/i.test(toast.evidence.browser.userAgent));
    const diagnosticRefusal = await run({ applyUrl: `${base}/diagnostic-refused` });
    const diagnostics = diagnosticRefusal.evidence.diagnostics;
    check('a refused submit records console and uncaught browser errors privately', diagnosticRefusal.event.error === 'portal_refused'
      && diagnostics.console.some((entry) => entry.text.includes('Profile URL invalid'))
      && diagnostics.pageErrors.some((entry) => entry.message === 'client_submit_validation')
      && !JSON.stringify(diagnostics).includes('private-test-token'));
    check('chunked HTTP 200 application errors and native field validation are captured', diagnostics.responses.some((entry) => entry.source === 'browser_stream' && entry.status === 200 && entry.errors?.some((error) => error.code === 'INVALID_URL'))
      && diagnostics.validation.some((entry) => entry.phase === 'after_submit' && entry.frames.some((frame) => frame.invalid.some((field) => field.label === 'LinkedIn'))));
    const moved = await run({ applyUrl: `${base}/refused-moved` });
    check('a refusal on the error page the portal moved to is a refusal too', moved.event.type === 'submit_failed'
      && moved.event.error === 'portal_refused' && moved.evidence.finalUrl.endsWith('/refused-moved/error'));
    // Coop (2026-10-02): career page → Prospective.ch redirect → SuccessFactors, on an account of its own.
    const coopSaved = new Map();
    const coopAccounts = {
      async load(host) { return coopSaved.get(host) || null; },
      async save(host, { email, password }) { coopSaved.set(host, { email, password, createdAt: Date.now(), verifiedAt: null }); },
      async mark(host, patch) { coopSaved.set(host, { ...coopSaved.get(host), ...patch }); },
      async discard(host) { coopSaved.delete(host); },
      async waitForVerification() { return null; },
    };
    const coopJob = { company: 'Coop Genossenschaft', title: 'Bäcker:in - Konditor:in (Schwerpunkt Bäckerei)' };
    const coopDry = await run({ applyUrl: `${base}/coop-job`, job: coopJob, accounts: coopAccounts, dryRun: true });
    check('Coop: past the shadow cookie banner, «Jetzt bewerben» (never «Später bewerben») reaches SuccessFactors’ registration', coopDry.event.type === 'dry_run_ready'
      && coopDry.event.stage === 'account' && coop.later === 0 && coop.accounts.size === 0);
    const coopFirst = await run({ applyUrl: `${base}/coop-job`, job: coopJob, accounts: coopAccounts });
    const coopAuth = coopFirst.evidence.steps.filter((step) => step.auth).map((step) => step.auth);
    check('Coop: the account is created (16-character password, country, privacy statement accepted, no job alert) and the application sent with «Bewerben»',
      coopFirst.event.type === 'submit_succeeded' && coop.accounts.size === 1 && coop.privacyAccepted === 1 && !coop.jobAbo
      && coop.refused.length === 0 && coopAuth.some((auth) => auth.privacy === 'accepted') && coopFirst.evidence.finalButton?.label === 'Bewerben'
      && coop.applications.length === 1 && coop.applications[0].hasCv && coop.applications[0].first === 'Luca');
    check('Coop: the sign-in page names no company, so the posting is checked on the form behind it', coopFirst.evidence.postingMatch === 'match');
    const coopAgain = await run({ applyUrl: `${sfOrigin(server)}${SF_JOB}`, job: coopJob, accounts: coopAccounts });
    check('Coop: a run that starts on SuccessFactors (the resolved redirect) signs in with the stored account', coopAgain.event.type === 'submit_succeeded'
      && coopAgain.evidence.steps.filter((step) => step.auth).map((step) => step.auth.kind).join(',') === 'sign_in' && coop.accounts.size === 1 && coop.applications.length === 2);
    check('the agent picks the day on the calendar and the runner sends the form', widget.event.type === 'submit_succeeded'
      && state.widgetApplications.length === 1 && state.widgetApplications[0].dob === '1990-05-12' && state.widgetApplications[0].hasCv
      && agentSteps.length === 1 && agentSteps[0].agent[0].status === 'done');
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
  const failed = checks.filter((item) => !item.ok).length;
  console.log(failed ? `${failed} check(s) failed` : 'portal e2e ok');
  process.exitCode = failed ? 1 : 0;
}

await main();
