/**
 * The owner's fill extension (scripts/assisted-application/extension) in a
 * real Chromium, end to end: a stand-in owner queue hands over a fill kit, the
 * extension opens a JOIN-like portal (giro di prova 2026-10-01: e-mail step
 * with «Continua con Google», CV, names, a searched city, lettered choices that
 * move on by themselves, a calendar, the review page) and must reach the
 * review page on its own, with the send button highlighted and never pressed
 * (the portal and the documents come from a local server: a tab the extension
 * opens is not routed by Playwright).
 * Then the test presses it, as Valerie does, and the queue must hear that the
 * portal confirmed. No employer, no secret: the portal is served by the test.
 *
 *   node scripts/assisted-application/extension-e2e.mjs
 */
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const EXTENSION = fileURLToPath(new URL('./extension/', import.meta.url));
const QUEUE = 'https://frontaliereticino.ch/gestione-contenuti-xk9mp2q/';

const queuePage = `<!doctype html><html><body><h1>Coda</h1><script>
  window.__statuses = [];
  window.addEventListener('message', (event) => { if (event.data && event.data.source === 'compila-candidatura') window.__statuses.push(event.data); });
</script></body></html>`;

const postingPage = '<!doctype html><html lang="it"><body><main><h1>Infermiere/a diplomato/a</h1><p>Frontaliere Ticino</p><a href="/apply">Candidarsi</a></main></body></html>';

// JOIN's wizard, client side: one question per step, «Continua» enabled when answered.
const applyPage = `<!doctype html><html lang="it"><body><main><form id="wizard"></form></main><div id="menu"></div><script>
const state = window.__portal = { step: 'authentication', email: '', file: '', first: '', last: '', city: '', availability: '', dob: '', gender: '', google: false, submits: 0, shown: '1986-07' };
const form = document.getElementById('wizard');
form.addEventListener('submit', (event) => event.preventDefault());
const steps = ['authentication', 'cv', 'personal', 'availability', 'dob', 'gender', 'review'];
const go = () => { state.step = steps[steps.indexOf(state.step) + 1]; render(); };
const buttons = (enabled) => '<div><button type="button" id="back"><span>Indietro</span></button><button type="button" id="next"' + (enabled ? '' : ' disabled') + '><span>Continua</span></button></div>';
const radios = (question, options) => '<h2>' + question + '</h2><div>' + options.map((option, index) => '<div><div role="radio" aria-checked="false" tabindex="0" data-option="' + option + '"><div><p>' + 'abcdef'[index] + '</p></div><p>' + option + '</p></div></div>').join('') + '</div>' + buttons(false);
function days() {
  const [year, month] = state.shown.split('-').map(Number);
  const cells = [];
  for (let day = 1; day <= 28; day += 1) {
    const value = year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    cells.push('<td role="gridcell"><div data-part="table-cell-trigger" role="button" data-value="' + value + '">' + day + '</div></td>');
  }
  return cells.join('');
}
function render() {
  const s = state.step;
  if (s === 'authentication') form.innerHTML = '<div role="group"><label for="email">Email</label><input id="email" type="email" aria-label="Email" value=""></div><button type="button" id="next" disabled><span>Continua</span></button><button type="button" id="google"><span>Continua con Google</span></button>';
  if (s === 'cv') form.innerHTML = '<h2>Carica il tuo CV</h2><div><div><p>Carica file</p><input id="cv" type="file" accept=".pdf" aria-hidden="true" tabindex="-1"></div></div><input type="file" accept="image/png,.png" id="avatar">' + buttons(false);
  if (s === 'personal') form.innerHTML = '<h2>Informazioni personali</h2><div role="group"><label for="first" data-required="">Nome<span aria-hidden="true">*</span></label><input id="first" required maxlength="30"></div><div role="group"><label for="last" data-required="">Cognome<span aria-hidden="true">*</span></label><input id="last" required maxlength="30"></div><div role="group"><label for="_r_h_">Città</label><div data-testid="CityName"><div id="city-box"><div id="react-select-1-placeholder">Selezionare la città</div><div><input id="city" role="combobox" type="text" value=""></div></div></div></div>' + buttons(false);
  if (s === 'availability') form.innerHTML = radios('Quando può iniziare?', ['Da subito', 'Entro 2 settimane', 'Entro 1 mese', 'Entro 3 mesi', 'Oltre 3 mesi']);
  if (s === 'dob') form.innerHTML = '<h2>Quando sei nato?</h2><div data-scope="date-picker" data-part="root" data-empty=""><div><button type="button" data-part="prev-trigger" aria-label="Switch to previous month"></button><span id="shown">' + state.shown + '</span><button type="button" data-part="next-trigger" aria-label="Switch to next month"></button></div><table data-part="table"><tbody><tr>' + days() + '</tr></tbody></table></div>' + buttons(false);
  if (s === 'gender') form.innerHTML = radios('Che sesso sei?', ['Maschio', 'Femmina', 'N/A']);
  if (s === 'review') form.innerHTML = '<h2>Esamina la tua candidatura</h2><p>Inviando la candidatura accetto il JOIN Termini e Condizioni.</p><div><button type="button" id="back"><span>Indietro</span></button><button type="submit" id="send"><span>Conferma e applica</span></button></div>';
}
const enableNext = (on) => { const next = document.getElementById('next'); if (next) next.disabled = !on; };
document.addEventListener('input', (event) => {
  const t = event.target;
  if (t.id === 'email') { state.email = t.value; enableNext(/@/.test(t.value)); }
  if (t.id === 'first') state.first = t.value;
  if (t.id === 'last') state.last = t.value;
  if (state.step === 'personal') enableNext(state.first && state.last);
  if (t.id === 'city') {
    document.getElementById('menu').innerHTML = ['Comano', 'Como', 'Comologno'].filter((city) => city.toLowerCase().startsWith(t.value.toLowerCase().slice(0, 3)))
      .map((city, index) => '<div role="option" id="react-select-1-option-' + index + '">' + city + '</div>').join('');
  }
});
document.addEventListener('change', (event) => {
  if (event.target.id === 'cv' && event.target.files.length) { state.file = event.target.files[0].name; state.fileSize = event.target.files[0].size; enableNext(true); }
});
document.addEventListener('click', (event) => {
  const option = event.target.closest('[role="option"]');
  if (option) { state.city = option.textContent; document.getElementById('city-box').innerHTML = '<div><p>' + option.textContent + '</p></div>'; document.getElementById('menu').innerHTML = ''; return; }
  const radio = event.target.closest('[role="radio"]');
  if (radio) { radio.setAttribute('aria-checked', 'true'); state[state.step] = radio.dataset.option; setTimeout(go, 300); return; }
  const cell = event.target.closest('[data-part="table-cell-trigger"]');
  if (cell) { state.dob = cell.dataset.value; document.querySelector('[data-scope="date-picker"]').removeAttribute('data-empty'); cell.setAttribute('data-selected', ''); enableNext(true); return; }
  const arrow = event.target.closest('[data-part$="-trigger"]');
  if (arrow) { const [y, m] = state.shown.split('-').map(Number); const n = y * 12 + (m - 1) + (arrow.dataset.part === 'next-trigger' ? 1 : -1); state.shown = Math.floor(n / 12) + '-' + String((n % 12) + 1).padStart(2, '0'); render(); return; }
  const button = event.target.closest('button');
  if (!button) return;
  if (button.id === 'google') state.google = true;
  if (button.id === 'next' && !button.disabled) go();
  if (button.id === 'send') { state.submits += 1; window.location.href = '/thanks'; }
});
render();
</script></body></html>`;

const kit = {
  version: 1,
  orderId: 'e2e-order',
  applyUrl: '',
  job: { title: 'Infermiere/a diplomato/a', company: 'Frontaliere Ticino' },
  language: 'it',
  identity: { firstName: 'Luigi', lastName: 'Prova', fullName: 'Luigi Prova', email: 'c-abcdefghjk@candidature.frontaliereticino.ch', phone: '', location: 'Como, Italia', address: { street: '', postalCode: '', city: 'Como', country: 'Italia' }, linkedin: '', website: '' },
  profile: { dateOfBirth: '', nationality: '', workPermit: '', availability: '', salary: '' },
  answers: [
    { question: 'Email', answer: 'c-abcdefghjk@candidature.frontaliereticino.ch', source: 'identity' },
    { question: 'Carica il tuo CV · Carica file', answer: '[CV]', source: 'documents' },
    { question: 'Nome *', answer: 'Luigi', source: 'identity' },
    { question: 'Cognome *', answer: 'Prova', source: 'identity' },
    { question: 'Città', answer: 'Como', source: 'identity' },
    { question: 'Quando può iniziare?', answer: 'Oltre 3 mesi', source: 'answers' },
    { question: 'Quando sei nato?', answer: '1986-09-12', source: 'answers' },
    { question: 'Che sesso sei?', answer: 'N/A', source: 'rule' },
  ],
  texts: { coverLetter: '', motivationShort: '', whyCompany: '' },
  documents: { cv: null, coverLetter: null },
};

const checks = [];
const check = (name, ok) => {
  checks.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}`);
};

async function main() {
  // The portal and the documents: a real local server.
  const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
  let thanks = 0;
  const files = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    if (pathname === '/cv.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(pdf); }
    if (pathname === '/job/1' || pathname === '/apply') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(pathname === '/apply' ? applyPage : postingPage); }
    // The confirmation is a new document (review of #10759): the tab must still know it reached the send button.
    if (pathname === '/thanks') { thanks += 1; res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><html lang="it"><body><h1>Grazie per la tua candidatura!</h1></body></html>'); }
    res.writeHead(404);
    return res.end();
  });
  await new Promise((resolve) => files.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${files.address().port}`;
  kit.applyUrl = `${base}/job/1`;
  kit.documents.cv = { url: `${base}/cv.pdf`, fileName: 'CV_Luigi_Prova.pdf' };
  const profile = await mkdtemp(path.join(tmpdir(), 'aa-extension-e2e-'));
  // The full Chromium in its new headless mode loads extensions (the headless shell does not).
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    // A local full Chromium build when Playwright's own is not installed.
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_FULL_PATH || undefined,
    headless: process.env.HEADED !== '1',
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  // A Chromium that does not start still releases the local server.
  }).catch((error) => { files.close(); throw error; });
  try {
    await context.route('https://frontaliereticino.ch/**', (route) => route.fulfill({ contentType: 'text/html', body: queuePage }));
    const queue = await context.newPage();
    await queue.goto(QUEUE);
    const installed = await queue.waitForFunction(() => document.documentElement.dataset.compilaCandidatura, null, { timeout: 15_000 }).then(() => true, () => false);
    check('the queue page sees the installed extension', installed);
    if (!installed) return;
    const opened = context.waitForEvent('page', { timeout: 15_000 });
    await queue.evaluate((data) => window.postMessage({ source: 'frontaliere-queue', type: 'fill-order', kit: data }, window.location.origin), kit);
    const portal = await opened;
    // The whole wizard, alone, up to the highlighted send button.
    const reached = await portal.waitForFunction(() => /solid/.test(document.getElementById('send')?.style.outline || ''), null, { timeout: 60_000 }).then(() => true, () => false);
    const state = await portal.evaluate(() => window.__portal || {}).catch(() => ({}));
    check('the extension walks every step to the review page by itself', reached && state.step === 'review');
    if (!reached) {
      const where = await portal.evaluate(() => ({ text: document.body.innerText.slice(0, 300), box: Boolean(document.querySelector('[data-compila-candidatura]')) })).catch((error) => ({ error: String(error) }));
      console.log('stopped at', portal.url(), JSON.stringify({ step: state.step, ...where }));
    }
    check('it starts from the posting and signs in with the alias, never with Google', state.email === kit.identity.email && state.google === false);
    check('it attaches the CV under its name, never to the avatar', state.file === 'CV_Luigi_Prova.pdf' && state.fileSize === pdf.length);
    check('it types the names and picks the searched city', state.first === 'Luigi' && state.last === 'Prova' && state.city === 'Como');
    check('it answers the lettered choices and the calendar as the runner did', state.availability === 'Oltre 3 mesi' && state.gender === 'N/A' && state.dob === '1986-09-12');
    check('it never presses the send button', state.submits === 0);
    const ready = await queue.waitForFunction(() => window.__statuses.some((item) => item.status === 'ready'), null, { timeout: 10_000 }).then(() => true, () => false);
    check('the queue hears that everything is filled', ready);
    // Valerie's click.
    await portal.click('#send');
    const submitted = await queue.waitForFunction(() => window.__statuses.some((item) => item.status === 'submitted' && item.orderId === 'e2e-order'), null, { timeout: 15_000 }).then(() => true, () => false);
    await queue.waitForTimeout(3000);
    const statuses = await queue.evaluate(() => window.__statuses.filter((item) => item.type === 'fill-status').map((item) => item.status));
    check('her press is told to the queue before the portal answers', statuses.indexOf('clicked') >= 0 && statuses.indexOf('clicked') < statuses.indexOf('submitted'));
    check('after her click the queue hears once that the portal confirmed, on its new page', submitted && thanks === 1 && statuses.filter((status) => status === 'submitted').length === 1);
  } finally {
    await context.close();
    files.close();
    await rm(profile, { recursive: true, force: true });
  }
}

await main();
const failed = checks.filter((item) => !item.ok).length;
console.log(failed || !checks.length ? `${failed || 'no'} check(s) failed` : 'extension e2e ok');
process.exitCode = failed || !checks.length ? 1 : 0;
