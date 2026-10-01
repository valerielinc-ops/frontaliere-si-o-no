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
      const document = entry?.kit?.documents?.[message.which];
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
      await chrome.storage.session.set({ [tabKey(sender.tab.id)]: { ...entry, sawForm: entry.sawForm || Boolean(message.sawForm), sawFinal: entry.sawFinal || Boolean(message.sawFinal) } });
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
      const portalSite = siteOf(new URL(portal.kit.applyUrl).hostname);
      if (siteOf(url.hostname) !== portalSite) return { ok: false, error: 'other_site' };
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
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete' || !(await entryFor(tabId))) return;
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['runner-fields.js', 'filler.js', 'content.js'] }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(tabKey(tabId));
});
