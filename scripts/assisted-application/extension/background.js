/**
 * Compila candidatura — service worker. The owner queue (bridge.js) hands
 * over an order's fill kit; this opens the portal in a new tab, injects the
 * page engine there on every load, downloads the documents from the kit's
 * signed links and relays the portal tab's progress back to the queue tab.
 * The kit lives in session storage only (gone when the browser closes).
 */
const tabKey = (tabId) => `tab:${tabId}`;

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
      const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
      if (url.protocol !== 'https:' && !loopback) return { ok: false, error: 'apply_url_not_https' };
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
    case 'status': {
      const entry = sender.tab ? await entryFor(sender.tab.id) : null;
      if (!entry) return { ok: false };
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
// the engine, then the loop, in every frame (some portals embed the form).
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete' || !(await entryFor(tabId))) return;
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['filler.js', 'content.js'] }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(tabKey(tabId));
});
