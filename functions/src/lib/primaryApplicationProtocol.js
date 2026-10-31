/** Primary public posting proof. No browser, scripts, model or candidate data. */
import { parse } from 'parse5';
import { isFetchablePublicUrl } from '../assistedApplicationAiJob.js';
import { publicContractGet } from './publicContractTransport.js';
import { avatureProtocolMatches, avaturePostingJobKey, nativeApplicationSourceAuthority, primaryApplicationProtocolFromRecords, isReadOnlyPrimarySourceUrl } from './nativeApplicationTarget.js';

export const PRIMARY_PROTOCOL_MAX_BYTES = 524_288;
export const PRIMARY_PROTOCOL_MAX_JSON_BYTES = 65_536;
function boundedProtocol(protocol) {
  return protocol && Buffer.byteLength(JSON.stringify(protocol)) <= PRIMARY_PROTOCOL_MAX_JSON_BYTES ? protocol : null;
}
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const cleanTitle = value => String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();

function canonicalPublicSourceUrl(value) {
  try {
    const url = new URL(value);
    return isFetchablePublicUrl(value) && !url.hash
      && value.length <= 8192 && url.href === value;
  } catch { return false; }
}

/** This is only a read-route guard; metadata independently supplies job identity. */
export function isPrimaryApplicationPostingUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      && url.href === value && /^\/[A-Za-z][A-Za-z0-9_-]{0,79}\/JobDetail\/[^/]+\/[1-9][0-9]{0,15}\/?$/.test(url.pathname)
      && !/%(?:2f|5c|25)|[\\\u0000-\u001f\u007f]/iu.test(url.pathname);
  } catch { return false; }
}

/** Pure archived-data decoder: no requests or capabilities. The provider below enforces read policy. */
export function primaryApplicationProtocolFromHtml(html, { applyUrl, jobTitle } = {}) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > PRIMARY_PROTOCOL_MAX_BYTES
    || !canonicalPublicSourceUrl(applyUrl) || typeof jobTitle !== 'string' || !cleanTitle(jobTitle) || cleanTitle(jobTitle).length > 500) return null;
  const document = parse(html, { scriptingEnabled: true });
  const metas = new Map(); const bootstrap = []; const headings = []; const forms = []; const controls = []; const anchors = []; const bases = []; const elements = [];
  const stack = [{ node: document, depth: 0 }]; let visited = 0;
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (++visited > 20_000 || depth > 256) return null;
    if (['script', 'style', 'template', 'noscript'].includes(node.tagName)) continue;
    if (node.namespaceURI !== HTML_NAMESPACE && ['h1', 'meta', 'portal-data'].includes(node.tagName)) return null;
    if (node.namespaceURI === HTML_NAMESPACE) {
      elements.push(node);
      const attr = name => (node.attrs || []).find(item => item.name === name)?.value || '';
      if (node.tagName === 'meta' && ['avature.portal.id', 'avature.portal.urlPath', 'avature.portal.page'].includes(attr('name'))) {
        const name = attr('name'); const values = metas.get(name) || []; values.push(attr('content').trim()); metas.set(name, values);
      }
      if (node.tagName === 'portal-data' && attr('id') === 'synapserBootstrap') bootstrap.push(node);
      if (node.tagName === 'h1') headings.push(node);
      if (node.tagName === 'form') forms.push(node);
      if (['input', 'select', 'textarea', 'button'].includes(node.tagName)) controls.push(node);
      if (node.tagName === 'a') anchors.push(node);
      if (node.tagName === 'base') bases.push(node);
    }
    for (const child of node.childNodes || []) stack.push({ node: child, depth: depth + 1 });
  }
  if (headings.length !== 1 || [...metas.values()].some(values => values.length !== 1)) return null;
  const text = node => node.nodeName === '#text' ? node.value
    : ['script', 'style', 'template', 'noscript'].includes(node.tagName) ? '' : (node.childNodes || []).map(text).join('');
  const sourceTitle = cleanTitle(text(headings[0]));
  if (!sourceTitle || sourceTitle.length > 500 || sourceTitle !== cleanTitle(jobTitle)) return null;
  if (!isPrimaryApplicationPostingUrl(applyUrl)) {
    const attr = (node, name) => (node.attrs || []).find(item => item.name === name)?.value ?? null;
    const closestForm = node => {
      for (let parent = node.parentNode; parent; parent = parent.parentNode) if (parent.tagName === 'form' && parent.namespaceURI === HTML_NAMESPACE) return parent;
      return null;
    };
    // Only physical native ownership is represented. A form= reassignment or
    // an orphan associated control requires an independently supported reader.
    if (controls.some(node => attr(node, 'form') !== null)) return null;
    const namedBases = bases.filter(node => attr(node, 'href') !== null);
    if (namedBases.length > 1) return null;
    if (namedBases.length) {
      try {
        const base = new URL(attr(namedBases[0], 'href'), applyUrl);
        if (base.protocol !== 'https:' || base.origin !== new URL(applyUrl).origin || base.username || base.password || base.search || base.hash) return null;
        // Relative action semantics would require the base context in the
        // shared decoder; never silently reinterpret it as a document URL.
        if (forms.some(form => { const action = attr(form, 'action'); return action && !/^https:\/\//iu.test(action); })) return null;
      } catch { return null; }
    }
    const label = node => {
      const ids = attr(node, 'aria-labelledby');
      if (ids !== null) {
        const refs = ids.trim().split(/\s+/u).filter(Boolean);
        if (!refs.length || refs.length > 24) throw new Error('primary_label_unknown');
        const value = cleanTitle(refs.map(id => { const matches = elements.filter(element => attr(element, 'id') === id);
          if (matches.length !== 1) throw new Error('primary_label_unknown');
          const value = cleanTitle(text(matches[0])); if (!value || value.length > 300) throw new Error('primary_label_unknown'); return value; }).join(' '));
        if (value.length > 300) throw new Error('primary_label_unknown'); return value;
      }
      const value = cleanTitle(attr(node, 'aria-label') || text(node) || attr(node, 'value') || attr(node, 'title'));
      if (value.length > 300) throw new Error('primary_label_unknown'); return value;
    };
    let records;
    try {
      records = forms.map(form => ({ action: attr(form, 'action'), method: attr(form, 'method'),
        controls: controls.filter(node => closestForm(node) === form).map(node => ({ tag: node.tagName,
          type: attr(node, 'type'), name: attr(node, 'name') || '', autocomplete: attr(node, 'autocomplete') || '',
          multiple: attr(node, 'multiple') !== null })),
        submitters: [...anchors, ...controls.filter(node => node.tagName === 'button' || node.tagName === 'input' && ['submit', 'image'].includes(String(attr(node, 'type') || '').toLowerCase()))]
          .filter(node => closestForm(node) === form).map(node => ({ tag: node.tagName, href: attr(node, 'href'),
            type: attr(node, 'type'), name: attr(node, 'name') || '', value: attr(node, 'value') || '',
            inlineHandler: attr(node, 'onclick'), label: label(node), formRelation: node.tagName === 'a' ? 'closest' : 'native',
            formAction: attr(node, 'formaction'), formMethod: attr(node, 'formmethod'),
            formTarget: attr(node, 'formtarget'), formEnctype: attr(node, 'formenctype') })) }));
    } catch { return null; }
    const sourceProtocol = primaryApplicationProtocolFromRecords({ sourceUrl: applyUrl, headings: [sourceTitle], forms: records });
    return sourceProtocol && sourceProtocol.sourceTitle === cleanTitle(jobTitle) ? boundedProtocol(sourceProtocol) : null;
  }
  if (bootstrap.length !== 1) return null;
  const attr = name => (bootstrap[0].attrs || []).find(item => item.name === name)?.value || '';
  const portalId = metas.get('avature.portal.id')?.[0] || '';
  const urlPath = metas.get('avature.portal.urlPath')?.[0] || '';
  const page = metas.get('avature.portal.page')?.[0] || '';
  const url = new URL(applyUrl);
  const sourceProtocol = { vendor: 'avature', portalId, namespace: `/${urlPath}`, page,
    origin: url.origin, path: url.pathname, sourceTitle,
    quoted: { portalId, urlPath, page, applicationName: attr('data-applicationname'),
      applicationCode: attr('data-applicationcode'), sourceTitle, titleSource: 'unique-h1' } };
  return page === 'JobDetail' && avatureProtocolMatches(sourceProtocol, applyUrl) && avaturePostingJobKey(applyUrl, sourceProtocol)
    && nativeApplicationSourceAuthority({ applyUrl, sourceProtocol, jobTitle }) ? boundedProtocol(sourceProtocol) : null;
}

/** Server-owned URL/title only. Every redirect remains a public read-only posting route. */
export async function readPrimaryApplicationProtocol({ applyUrl, jobTitle } = {}, { resolve, requestImpl, signal } = {}) {
  if (!canonicalPublicSourceUrl(applyUrl) || !isReadOnlyPrimarySourceUrl(applyUrl) || typeof jobTitle !== 'string' || !cleanTitle(jobTitle) || cleanTitle(jobTitle).length > 500) return null;
  const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000);
  let totalBytes = 0;
  try {
    const response = await publicContractGet(applyUrl, { resolve, requestImpl, signal: boundedSignal,
      maxBytes: PRIMARY_PROTOCOL_MAX_BYTES, validateUrl: value => isReadOnlyPrimarySourceUrl(value) && (value === applyUrl || isPrimaryApplicationPostingUrl(value)),
      onBytes: bytes => { totalBytes += bytes; if (totalBytes > PRIMARY_PROTOCOL_MAX_BYTES) throw new Error('primary_protocol_byte_budget'); } });
    if (response.status !== 200 || !/^text\/html(?:\s*;|\s*$)/iu.test(String(response.headers['content-type'] || ''))
      || Number(response.headers['content-length'] || 0) > PRIMARY_PROTOCOL_MAX_BYTES) return null;
    const sourceProtocol = primaryApplicationProtocolFromHtml(response.body.toString('utf8'), { applyUrl: response.url, jobTitle });
    return sourceProtocol ? boundedProtocol({ applyUrl: response.url, sourceProtocol }) : null;
  } catch { return null; }
}
