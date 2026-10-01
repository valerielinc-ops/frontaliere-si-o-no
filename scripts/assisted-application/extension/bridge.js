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

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (data?.source !== 'frontaliere-queue' || data.type !== 'fill-order' || !data.kit) return;
    chrome.runtime.sendMessage({ type: 'fill-order', kit: data.kit })
      .then((response) => window.postMessage({ source: 'compila-candidatura', type: 'fill-opened', orderId: data.kit.orderId, ok: Boolean(response?.ok), error: response?.error || '' }, window.location.origin))
      .catch((error) => window.postMessage({ source: 'compila-candidatura', type: 'fill-opened', orderId: data.kit.orderId, ok: false, error: String(error?.message || error) }, window.location.origin));
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'fill-status') return;
    window.postMessage({ source: 'compila-candidatura', type: 'fill-status', orderId: message.orderId, status: message.status, detail: message.detail }, window.location.origin);
  });
})();
