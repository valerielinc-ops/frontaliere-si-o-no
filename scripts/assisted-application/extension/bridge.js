/**
 * Compila candidatura — the owner queue's side. Tells the page the extension
 * is installed, passes the queue's "fill this order" to the service worker,
 * and the portal tab's progress back to the page (which marks the order as
 * sent when the portal confirmed). Only messages from this very page, with
 * this protocol's tags, cross.
 */
(function () {
  'use strict';
  document.documentElement.dataset.compilaCandidatura = chrome.runtime.getManifest().version;
  // Cut off when the extension reloads itself after an update (background.js):
  // the service worker then injects a new bridge into this tab.
  const alive = () => Boolean(chrome.runtime?.id);
  globalThis.compilaCandidaturaBridgeAlive = alive;

  const onMessage = (event) => {
    if (!alive()) {
      window.removeEventListener('message', onMessage);
      return;
    }
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (data?.source === 'frontaliere-queue' && data.type === 'open-verification' && data.orderId && data.url) {
      // The service worker's answer goes back to the queue: it shows success only when the link opened.
      const answer = (response) => window.postMessage({ source: 'compila-candidatura', type: 'verification-opened', orderId: data.orderId, ok: Boolean(response?.ok), error: response?.error || '' }, window.location.origin);
      chrome.runtime.sendMessage({ type: 'open-verification', orderId: data.orderId, url: data.url })
        .then(answer, (error) => answer({ ok: false, error: String(error?.message || error) }));
      return;
    }
    if (data?.source !== 'frontaliere-queue' || data.type !== 'fill-order' || !data.kit) return;
    chrome.runtime.sendMessage({ type: 'fill-order', kit: data.kit })
      .then((response) => window.postMessage({ source: 'compila-candidatura', type: 'fill-opened', orderId: data.kit.orderId, ok: Boolean(response?.ok), error: response?.error || '' }, window.location.origin))
      .catch((error) => window.postMessage({ source: 'compila-candidatura', type: 'fill-opened', orderId: data.kit.orderId, ok: false, error: String(error?.message || error) }, window.location.origin));
  };
  window.addEventListener('message', onMessage);

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'fill-status') return;
    window.postMessage({ source: 'compila-candidatura', type: 'fill-status', orderId: message.orderId, status: message.status, detail: message.detail }, window.location.origin);
  });
})();
