/**
 * Compila candidatura — service worker. The owner queue (bridge.js) hands
 * over an order's fill kit; this opens the portal in a new tab, injects the
 * page engine there on every load, downloads the documents from the kit's
 * signed links and relays the portal tab's progress back to the queue tab.
 * The kit lives in session storage only (gone when the browser closes).
 */
const tabKey = (tabId) => `tab:${tabId}`;

/** The order's tabs (an order may have its portal tab and the verification tab). */
async function tabsOfOrder(orderId) {
  const all = await chrome.storage.session.get(null);
  return Object.entries(all).filter(([key, entry]) => key.startsWith('tab:') && entry?.kit?.orderId === orderId)
    .map(([key, entry]) => ({ tabId: Number(key.slice(4)), entry }));
}

// This computer's own test server (scripts/assisted-application/extension-e2e.mjs): the only http allowed.
const isLoopback = (url) => url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);

// "join.com" for "join.com" and "www.join.com": the verification link must be the portal's own.
const siteOf = (host) => String(host || '').toLowerCase().split('.').slice(-2).join('.');

async function entryFor(tabId) {
  const key = tabKey(tabId);
  return (await chrome.storage.session.get(key))[key] || null;
}

function base64Of(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

async function handle(message, sender) {
  switch (message?.type) {
    case 'fill-order': {
      // From the queue tab: only an https portal page is opened (or this
      // computer's own test server, scripts/assisted-application/extension-e2e.mjs).
      const kit = message.kit;
      const url = new URL(String(kit?.applyUrl || ''));
      if (url.protocol !== 'https:' && !isLoopback(url)) return { ok: false, error: 'apply_url_not_https' };
      // The kit is stored before the portal loads: its first page is filled too.
      const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
      await chrome.storage.session.set({ [tabKey(tab.id)]: { kit, queueTabId: sender.tab?.id ?? null, state: 'filling', openedAt: Date.now() } });
      await chrome.tabs.update(tab.id, { url: url.href });
      return { ok: true, tabId: tab.id };
    }
    case 'get-kit':
      return { ok: true, entry: sender.tab ? await entryFor(sender.tab.id) : null };
    case 'fetch-document': {
      const entry = sender.tab ? await entryFor(sender.tab.id) : null;
      // "cv", "coverLetter", or one file of a requested document: "extra_2#0".
      const [slot, index] = String(message.which || '').split('#');
      const document = slot.startsWith('extra_')
        ? entry?.kit?.documents?.extra?.find((item) => item.slot === slot)?.files?.[Number(index) || 0]
        : entry?.kit?.documents?.[message.which];
      if (!document?.url) return { ok: false, error: 'no_document' };
      const response = await fetch(document.url);
      if (!response.ok) return { ok: false, error: `download_${response.status}` };
      return { ok: true, base64: base64Of(await response.arrayBuffer()), fileName: document.fileName, contentType: response.headers.get('content-type') || 'application/pdf' };
    }
    case 'mark': {
      // What a page of this tab saw (a form, the send button): the next
      // document of the same tab still knows it (review of #10759: a send
      // button that loads a new confirmation page).
      const entry = sender.tab ? await entryFor(sender.tab.id) : null;
      if (!entry) return { ok: false };
      await chrome.storage.session.set({ [tabKey(sender.tab.id)]: {
        ...entry,
        sawForm: entry.sawForm || Boolean(message.sawForm),
        sawFinal: entry.sawFinal || Boolean(message.sawFinal),
        // The engine pressed the posting's start: the tab it opens is the form's.
        ...(Number.isFinite(Number(message.startedAt)) && Number(message.startedAt) > 0
          ? { startedAt: Number(message.startedAt), startUrl: String(message.startUrl || '').slice(0, 8192) }
          : {}),
      } });
      return { ok: true };
    }
    case 'open-verification': {
      // From the queue: the verification link that reached the order's alias.
      // Opened only on the portal's own site, in a tab that keeps the order's
      // kit, so the confirmation it shows closes the order.
      const url = new URL(String(message.url || ''));
      const tabs = await tabsOfOrder(message.orderId);
      const portal = tabs[0]?.entry;
      if (!portal) return { ok: false, error: 'no_order_tab' };
      if (url.protocol !== 'https:' && !isLoopback(url)) return { ok: false, error: 'not_https' };
      // The kit's portal, or the one a tab of the order moved on to (Coop: the
      // career page hands over to SuccessFactors in a new tab).
      const sites = new Set([siteOf(new URL(portal.kit.applyUrl).hostname)]);
      for (const { tabId } of tabs) {
        const open = await chrome.tabs.get(tabId).catch(() => null);
        if (/^https?:/.test(open?.url || '')) sites.add(siteOf(new URL(open.url).hostname));
      }
      if (!sites.has(siteOf(url.hostname))) return { ok: false, error: 'other_site' };
      const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
      await chrome.storage.session.set({ [tabKey(tab.id)]: { ...portal, openedAt: Date.now(), verification: true } });
      await chrome.tabs.update(tab.id, { url: url.href });
      return { ok: true, tabId: tab.id };
    }
    case 'status': {
      const entry = sender.tab ? await entryFor(sender.tab.id) : null;
      if (!entry) return { ok: false };
      // Told to the queue once per order, whichever of its tabs saw it.
      if (message.status === 'submitted' && (await tabsOfOrder(entry.kit.orderId)).some((item) => item.entry.state === 'submitted')) return { ok: true, duplicate: true };
      if (message.status === 'submitted') {
        await chrome.storage.session.set({ [tabKey(sender.tab.id)]: { ...entry, state: 'submitted' } });
      }
      if (entry.queueTabId != null) {
        await chrome.tabs.sendMessage(entry.queueTabId, {
          type: 'fill-status', orderId: entry.kit.orderId, status: message.status, detail: message.detail || '',
        }).catch(() => {});
      }
      return { ok: true };
    }
    default:
      return { ok: false, error: 'unknown_message' };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender).then(sendResponse, (error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});

// Every page load of an order's tab (the posting, then each portal page):
// the runner's field reading, the engine, then the loop, in every frame (some portals embed the form).
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  // A tab the posting opened, whose address Chrome tells only now: adopted
  // when it is the link the start click pressed (adoptStartTab).
  if (awaitingAddress.has(tabId)) {
    const address = info.url || tab?.pendingUrl || tab?.url || '';
    if (/^https?:/.test(address)) {
      const opener = awaitingAddress.get(tabId);
      awaitingAddress.delete(tabId);
      await queue(() => adoptStartTab(tabId, opener, address));
    }
  }
  if (info.status !== 'complete' || !(await entryFor(tabId))) return;
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['runner-fields.js', 'filler.js', 'content.js'] }).catch(() => {});
});

// A posting that opens its form in a new tab (Coop's «Jetzt bewerben» goes to
// SuccessFactors with target=_blank, 2026-10-02): the new tab keeps the
// order's kit, so the engine is injected there too. Only the tab the engine's
// own start click opened: a social or privacy link of the posting, or a link a
// form opens (a job alert), gets nothing.
const START_TAB_WINDOW_MS = 30_000;

/** Same page: origin and path (the query of a redirect may differ). */
function sameTarget(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch {
    return false;
  }
}

/**
 * One tab per start click (reviews of #10980): only the tab whose address is
 * exactly the link the engine pressed. A tab whose address Chrome does not
 * know yet waits for it (onUpdated) instead of taking the kit; the start is
 * used up by the matching tab, so no other popup of the posting (privacy,
 * job alert, social) ever gets it. No link pressed, no tab adopted.
 * @returns {Promise<'adopted'|'wait'|'no'>}
 */
async function adoptStartTab(tabId, openerTabId, address) {
  const entry = await entryFor(openerTabId);
  if (!entry || entry.sawForm || entry.state === 'submitted' || await entryFor(tabId)) return 'no';
  if (!entry.startedAt || Date.now() - entry.startedAt > START_TAB_WINDOW_MS || !entry.startUrl) return 'no';
  if (!/^https?:/.test(address)) return 'wait';
  if (!sameTarget(address, entry.startUrl)) return 'no';
  const kit = { ...entry, startedAt: null, startUrl: '' };
  await chrome.storage.session.set({
    [tabKey(openerTabId)]: kit,
    [tabKey(tabId)]: { ...kit, openedAt: Date.now(), openedFrom: openerTabId },
  });
  return 'adopted';
}

// Tabs a posting opened whose address is not known yet: tab id → opener.
const awaitingAddress = new Map();
// Serialized: two popups at once never both read the same unused start.
let adopting = Promise.resolve();
function queue(task) {
  adopting = adopting.then(task).catch(() => {});
  return adopting;
}
chrome.tabs.onCreated.addListener((tab) => queue(async () => {
  if (tab.openerTabId == null) return;
  const outcome = await adoptStartTab(tab.id, tab.openerTabId, tab.pendingUrl || tab.url || '');
  if (outcome === 'wait') awaitingAddress.set(tab.id, tab.openerTabId);
}));

chrome.tabs.onRemoved.addListener((tabId) => {
  awaitingAddress.delete(tabId);
  chrome.storage.session.remove(tabKey(tabId));
});

// Updates: on the owner's Mac the folder Chrome loaded this extension from
// follows the site's main branch (scripts/assisted-application/extension-sync.sh).
// Once a minute the service worker compares its own files on disk with the
// ones it was loaded with and, when they changed and no order is being
// filled, reloads itself: nobody presses «Ricarica» in chrome://extensions.
const OWN_FILES = ['manifest.json', 'background.js', 'bridge.js', 'runner-fields.js', 'filler.js', 'content.js'];
const UPDATE_ALARM = 'update-check';
// A fill left half-way for longer than this no longer holds an update back.
const FILL_HOLD_MS = 2 * 60 * 60 * 1000;
// Never twice in a row: a load that does not take is not retried every minute.
const RELOAD_GAP_MS = 10 * 60 * 1000;

async function fingerprint() {
  const parts = await Promise.all(OWN_FILES.map(async (file) => {
    const response = await fetch(chrome.runtime.getURL(file), { cache: 'no-store' }).catch(() => null);
    return `${file}\n${response?.ok ? await response.text() : 'missing'}`;
  }));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('\n\0\n')));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** An order still being filled: none of its tabs saw the portal's confirmation yet. */
async function fillInProgress(nowMs) {
  const orders = new Map();
  for (const [key, entry] of Object.entries(await chrome.storage.session.get(null))) {
    if (!key.startsWith('tab:') || !entry?.kit) continue;
    const order = orders.get(entry.kit.orderId) || { submitted: false, recent: false };
    order.submitted = order.submitted || entry.state === 'submitted';
    order.recent = order.recent || nowMs - Number(entry.openedAt || 0) < FILL_HOLD_MS;
    orders.set(entry.kit.orderId, order);
  }
  return [...orders.values()].some((order) => order.recent && !order.submitted);
}

// A global of the worker: the end-to-end test (scripts/assisted-application/extension-e2e.mjs) calls it instead of waiting for the alarm.
async function checkForUpdate() {
  const nowMs = Date.now();
  const current = await fingerprint();
  const { loadedFingerprint } = await chrome.storage.session.get('loadedFingerprint');
  if (!loadedFingerprint) {
    await chrome.storage.session.set({ loadedFingerprint: current });
    return { changed: false };
  }
  if (current === loadedFingerprint) return { changed: false };
  if (await fillInProgress(nowMs)) return { changed: true, reloading: false, reason: 'filling' };
  const { lastReloadAt } = await chrome.storage.local.get('lastReloadAt');
  if (nowMs - Number(lastReloadAt || 0) < RELOAD_GAP_MS) return { changed: true, reloading: false, reason: 'just_reloaded' };
  await chrome.storage.local.set({ lastReloadAt: nowMs });
  // After the answer: whoever asked (the alarm, a test) is not cut off mid-call.
  setTimeout(() => chrome.runtime.reload(), 100);
  return { changed: true, reloading: true };
}

chrome.alarms.get(UPDATE_ALARM).then((alarm) => alarm || chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 1 }));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) checkForUpdate().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  checkForUpdate().catch(() => {});
});

// Installed or just reloaded: these files are the loaded ones, and a queue tab
// already open gets the bridge (the one it had belongs to the previous load,
// cut off from this service worker). Once per worker, whichever comes first:
// onInstalled, or the worker's first run after a load (a reload empties the
// session storage), so an open queue never keeps a cut-off bridge, nor gets two.
let loadSettled = null;
function settleLoad() {
  loadSettled = loadSettled || (async () => {
    await chrome.storage.session.set({ loadedFingerprint: await fingerprint() });
    const [{ matches, js }] = chrome.runtime.getManifest().content_scripts;
    for (const tab of await chrome.tabs.query({ url: matches })) {
      const target = { tabId: tab.id };
      const [probe] = await chrome.scripting.executeScript({ target, func: () => Boolean(globalThis.compilaCandidaturaBridgeAlive?.()) }).catch(() => []);
      if (!probe?.result) await chrome.scripting.executeScript({ target, files: js }).catch(() => {});
    }
  })();
  return loadSettled;
}
chrome.runtime.onInstalled.addListener(() => {
  settleLoad().catch(() => {});
});
chrome.storage.session.get('loadedFingerprint').then(({ loadedFingerprint }) => (loadedFingerprint ? null : settleLoad())).catch(() => {});
