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
 */
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchChromium } from '../lib/ensure-chromium.mjs';
import { submitViaPortal } from './lib/portal/portal.mjs';

const ALIAS = 'c-abcdefghjk@candidature.frontaliereticino.ch';

function fakePortal() {
  const state = { accounts: new Map(), verified: new Set(), sessions: new Set(), applications: [], newsletter: false, pending: null, refuseNextRegistration: false };
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
    res.writeHead(404);
    res.end();
  });
  return { server, state };
}

/** Planner stand-in: answers by label, as the real planner does for these fields. */
async function fakeCodex({ prompt }) {
  const form = JSON.parse(prompt.slice(prompt.lastIndexOf('{"form"'), prompt.lastIndexOf('\n\nReturn exactly'))).form;
  const actions = form.fields.map((field) => {
    const act = (action, value = '', extra = {}) => ({ fieldId: field.id, action, value, document: 'none', source: 'identity', ...extra });
    if (/e-?mail/i.test(field.label)) return act('fill', ALIAS);
    if (/datenschutz/i.test(field.label)) return act('check', '', { source: 'consent' });
    if (/vorname/i.test(field.label)) return act('fill', 'Luca');
    if (/nachname/i.test(field.label)) return act('fill', 'Bianchi');
    if (field.kind === 'file') return act('upload', '', { document: 'cv', source: 'documents' });
    return act('skip', '', { source: 'rule' });
  });
  return { actions, missingRequired: [] };
}

async function main() {
  const { server, state } = fakePortal();
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
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
  const failed = checks.filter((item) => !item.ok).length;
  console.log(failed ? `${failed} check(s) failed` : 'portal e2e ok');
  process.exitCode = failed ? 1 : 0;
}

await main();
