/**
 * Compila candidatura — runs in the portal tab the extension opened for an
 * order (background.js injects filler.js, then this file). On every settled
 * page: refuse the optional cookies, start the application from the posting,
 * fill what the kit answers, press the portal's own "next", and stop on the
 * last page with the send button highlighted. Valerie's click sends it; the
 * portal's confirmation is reported to the owner queue, which marks the
 * order as sent. Nothing is ever typed that the kit does not hold.
 */
(function () {
  'use strict';
  if (window.__compilaCandidatura) return;
  window.__compilaCandidatura = true;
  const F = globalThis.CompilaCandidatura;
  if (!F) return;
  const isTop = window === window.top;
  // Steps a whole application may take, and one page's attempts at moving on.
  const MAX_ADVANCES = 40;
  const state = { kit: null, busy: false, stopped: false, done: false, sawForm: false, sawFinal: false, advances: 0, lastAdvance: '', lastAdvanceAt: 0, started: '' };
  const attempts = new WeakMap();
  const uploaded = new Set();
  const files = {};
  let timer = null;

  const send = (message) => chrome.runtime.sendMessage(message).catch(() => null);
  let ticker = null;
  const report = (status, detail = '') => send({ type: 'status', status, detail: String(detail).slice(0, 300) });

  /** The Files of a document: the CV or the letter, a requested document's files (extra_N), or all of them (extra_all). */
  async function getFiles(which) {
    const extras = state.kit?.documents?.extra || [];
    const slots = which === 'extra_all' ? extras : extras.filter((item) => item.slot === which);
    if (!String(which).startsWith('extra_')) return [await getFile(which)].filter(Boolean);
    const out = [];
    for (const item of slots) {
      for (let index = 0; index < (item.files || []).length; index += 1) {
        const file = await getFile(`${item.slot}#${index}`);
        if (file) out.push(file);
      }
    }
    return out;
  }

  async function getFile(which) {
    if (files[which]) return files[which];
    const response = await send({ type: 'fetch-document', which });
    if (!response?.ok) return null;
    const bytes = Uint8Array.from(atob(response.base64), (char) => char.charCodeAt(0));
    files[which] = new File([bytes], response.fileName, { type: response.contentType || 'application/pdf' });
    return files[which];
  }

  // ---- The status box (top frame only, in its own shadow root) --------------
  const box = isTop ? createBox() : null;
  function createBox() {
    const host = document.createElement('div');
    host.setAttribute('data-compila-candidatura', '');
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        .card{font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;border-radius:12px;padding:12px 14px;width:300px;box-shadow:0 8px 30px rgba(0,0,0,.35)}
        .title{font-weight:800;color:#fff}.job{color:#94a3b8;font-size:12px;margin-top:2px}
        .status{margin-top:8px}.status.ok{color:#86efac}.status.warn{color:#fdba74}
        ul{margin:6px 0 0;padding-left:16px}li{margin:2px 0}
        button{margin-top:8px;font:inherit;background:#334155;color:#fff;border:0;border-radius:8px;padding:5px 10px;cursor:pointer}
      </style>
      <div class="card" role="status" aria-live="polite">
        <div class="title">Compila candidatura</div>
        <div class="job"></div>
        <div class="status">Preparo la compilazione…</div>
        <ul hidden></ul>
        <button type="button" class="stop">Ferma</button>
      </div>`;
    shadow.querySelector('.stop').addEventListener('click', () => {
      state.stopped = true;
      show('Compilazione fermata: continua tu sul portale.', 'warn');
    });
    (document.body || document.documentElement).appendChild(host);
    return shadow;
  }
  function show(text, tone = '', items = []) {
    if (!box) return;
    const status = box.querySelector('.status');
    status.textContent = text;
    status.className = `status ${tone}`;
    const list = box.querySelector('ul');
    list.hidden = !items.length;
    list.replaceChildren(...items.map((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      return li;
    }));
  }
  function highlight(element) {
    element.style.outline = '4px solid #f97316';
    element.style.outlineOffset = '3px';
    element.scrollIntoView({ block: 'center' });
  }

  /**
   * Valerie's press on the send button, reported at once (before the portal
   * answers): the queue records the round as possibly sent, so no second kit
   * leaves while the outcome is unknown. Only listened to, never stopped or
   * replayed: the click is hers.
   */
  function watchSend(button) {
    if (button.dataset.compilaWatched) return;
    button.dataset.compilaWatched = '1';
    let told = false;
    const tell = () => {
      if (told) return;
      told = true;
      report('clicked');
    };
    button.addEventListener('pointerdown', tell, { capture: true });
    button.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') tell(); }, { capture: true });
    button.closest('form')?.addEventListener('submit', tell, { capture: true });
  }

  // ---- The loop ---------------------------------------------------------------
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(tick, 700);
  }

  async function tick() {
    if (state.busy || state.stopped || state.done || !state.kit) return;
    state.busy = true;
    try {
      const page = F.pageState(document, { sawForm: state.sawForm });
      if (page.kind === 'confirmed') {
        // A confirmation counts only after this tab reached the send button
        // (in this document or an earlier one of the same tab).
        if (!state.sawFinal) return;
        state.done = true;
        clearInterval(ticker);
        show('Candidatura inviata ✓ — la segno come inviata nella coda.', 'ok');
        await report('submitted');
        return;
      }
      if (page.kind === 'refused') {
        show('Il portale dice che non ha inviato la candidatura: riprova dal pulsante evidenziato.', 'warn');
        await report('refused');
      }
      if (page.kind === 'verify') {
        // The verification e-mail reaches the order's alias: the queue
        // fetches its link and the extension opens it here. Asked once per page.
        if (state.verifyAsked === location.href) return;
        state.verifyAsked = location.href;
        show('Il portale chiede di verificare l’email dell’alias: apro il link appena arriva…');
        await report('verify-email');
        return;
      }
      const cookies = F.cookieRefusal(document);
      if (cookies && !state.sawForm) F.press(cookies);
      if (page.kind === 'posting') {
        if (state.started === location.href) return;
        state.started = location.href;
        show('Apro il modulo di candidatura…');
        // Before the click: a new tab it opens (Coop → SuccessFactors) keeps the order's kit.
        await send({ type: 'mark', startedAt: Date.now() });
        F.press(page.start);
        return;
      }
      const result = await F.fillPage(document, state.kit, { getFile, getFiles, attempts, uploaded });
      if (result.entries && !state.sawForm) {
        state.sawForm = true;
        await send({ type: 'mark', sawForm: true });
      }
      const after = F.pageState(document, { sawForm: state.sawForm });
      if (after.kind === 'final') {
        state.sawFinal = true;
        if (result.missing.length) {
          show('Mancano risposte prima dell’invio:', 'warn', result.missing.map((item) => item.label));
          await report('needs', result.missing.map((item) => item.label).join(' · '));
          return;
        }
        highlight(after.final);
        watchSend(after.final);
        show(`Tutto compilato. Premi «${F.textOf(after.final)}» (evidenziato) per inviare.`, 'ok');
        await send({ type: 'mark', sawFinal: true });
        await report('ready');
        return;
      }
      if (after.kind !== 'step') {
        if (result.filled.length) show(`Compilati ${result.filled.length} campi.`);
        return;
      }
      if (result.missing.length && after.nextDisabled) {
        show('Mi manca una risposta, completala tu:', 'warn', result.missing.map((item) => item.label));
        await report('needs', result.missing.map((item) => item.label).join(' · '));
        return;
      }
      if (after.nextDisabled) return; // an upload or a choice still settling: the next mutation retries
      // One press per page: the next one waits for the page to change.
      const signature = F.pageSignature(document);
      if (signature === state.lastAdvance && Date.now() - state.lastAdvanceAt < 8000) return;
      if (state.advances >= MAX_ADVANCES) {
        show('Troppi passaggi: mi fermo, continua tu.', 'warn');
        await report('stuck');
        return;
      }
      state.advances += 1;
      state.lastAdvance = signature;
      state.lastAdvanceAt = Date.now();
      show(`Passaggio ${state.advances}: compilato, vado avanti…`);
      F.press(after.next);
    } catch (error) {
      show(`Errore: ${String(error?.message || error).slice(0, 120)}`, 'warn');
    } finally {
      state.busy = false;
    }
  }

  (async () => {
    const response = await send({ type: 'get-kit' });
    const entry = response?.entry;
    if (!entry?.kit || entry.state === 'submitted') {
      box?.host.remove();
      return;
    }
    state.kit = entry.kit;
    state.sawForm = Boolean(entry.sawForm);
    state.sawFinal = Boolean(entry.sawFinal);
    if (box) box.querySelector('.job').textContent = [entry.kit.job?.title, entry.kit.job?.company].filter(Boolean).join(' — ');
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-checked', 'aria-disabled', 'data-empty'],
    });
    ticker = setInterval(schedule, 2500);
    schedule();
  })();
})();
