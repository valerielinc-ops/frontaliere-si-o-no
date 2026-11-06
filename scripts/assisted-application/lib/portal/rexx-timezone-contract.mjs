/** Recognize one demonstrated anonymous REXX timezone-ID lookup, not arbitrary POSTs. */
import { createHash } from 'node:crypto';
import { parse } from 'acorn';
import { activePublicDocumentScripts, walkScriptAst } from './read-only-asset-contracts.mjs';

const TEMPLATE = `if ($('#timezone').length) { if ($('#timezone').val() === null || $('#timezone').val() == '') {
  var timezoneName = Intl.DateTimeFormat().resolvedOptions().timeZone;
  $.ajax({ url: base_url_rexx + 'timezone.html', dataType: 'json', type: 'POST', data: { name: timezoneName },
    success: function(response) { if (response.success) { $('#timezone').val(response.id);
      if ($('#timezone-button').length) { $('#timezone-button').find('.ui-selectmenu-text').text(timezoneName); }
    } }
  });
} }`;
const syntax = source => parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
const keyOf = property => !property.computed && (property.key?.name ?? property.key?.value);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (['start', 'end', 'raw'].includes(key)) continue;
    result[key] = key === 'key' && value.type === 'Property' && keyOf(value)
      ? { type: 'StaticKey', name: String(keyOf(value)) } : canonical(value[key]);
  }
  return result;
}
const signature = value => JSON.stringify(canonical(value));
const template = syntax(TEMPLATE).body[0];
const outerTest = signature(template.test);
const inner = template.consequent.body[0];
const innerTest = signature(inner.test);
const block = signature(inner.consequent);

export function rexxTimeZoneSources(html, applyUrl) {
  const origin = new URL(applyUrl).origin;
  const bases = [];
  const scripts = [];
  const document = activePublicDocumentScripts(html, applyUrl);
  const activeScripts = document.scripts;
  const documentBase = document.baseUrl;
  if (!documentBase) return null;
  for (const { attrs, source } of activeScripts) {
    if (attrs.src) {
      try {
        const url = new URL(attrs.src, documentBase);
        if (url.href.length <= 2000 && url.origin === origin && !url.username && !url.password && !url.hash) scripts.push(url.href);
      } catch { /* Unsupported script identity grants no exception. */ }
      continue;
    }
    if (!/\bbase_url_rexx\b/.test(source) || source.length > 100_000) continue;
    try {
      for (const statement of syntax(source).body) {
        if (statement.type !== 'VariableDeclaration') continue;
        for (const node of statement.declarations) {
          if (node.id?.name === 'base_url_rexx' && node.init?.type === 'Literal'
            && typeof node.init.value === 'string') bases.push(node.init.value);
        }
      }
    } catch { return null; }
  }
  if (bases.length !== 1) return null;
  try {
    const base = new URL(bases[0]);
    if (base.protocol !== 'https:' || base.origin !== origin || base.search || base.hash
      || base.username || base.password || !base.pathname.endsWith('/')) return null;
    return { lookupUrl: new URL('timezone.html', base).href, scripts };
  } catch { return null; }
}

export function rexxTimeZoneProtocol(sources, scriptUrl, bytes) {
  if (!sources || sources.scripts.filter(url => url === scriptUrl).length !== 1 || bytes.length > 100_000) return null;
  let matches = 0;
  try {
    walkScriptAst(syntax(bytes.toString('utf8')), (node, parents) => {
      if (node.type !== 'BlockStatement' || signature(node) !== block) return;
      const owner = parents.at(-1);
      if (owner?.type === 'IfStatement' && owner.consequent === node && signature(owner.test) === innerTest
        && parents.some(parent => parent.type === 'IfStatement' && signature(parent.test) === outerTest)) matches++;
    });
  } catch { return null; }
  return matches === 1 ? { name: 'rexx-timezone-lookup-v1', lookupUrl: sources.lookupUrl,
    scriptUrl, scriptHash: createHash('sha256').update(bytes).digest('hex') } : null;
}

export function runtimeTimeZone(value) {
  if (typeof value !== 'string' || value.length > 100 || !/^[A-Za-z0-9_+/-]+$/.test(value)) return null;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return value; }
  catch { return null; }
}

export function rexxTimeZoneBody(timeZone) {
  if (!runtimeTimeZone(timeZone)) return null;
  return new URLSearchParams({ name: timeZone }).toString();
}

export function validRexxTimeZoneHeaders(headers) {
  return /^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(headers?.['content-type'] || '')
    && (!headers?.['content-length'] || /^\d{1,3}$/.test(headers['content-length'])
      && Number(headers['content-length']) > 0 && Number(headers['content-length']) <= 256);
}

export function validRexxTimeZoneRequest({ protocol, url, method, resourceType, mainFrame, timeZone, headers, body }) {
  const expected = rexxTimeZoneBody(timeZone);
  return Boolean(protocol && url === protocol.lookupUrl && method === 'POST' && mainFrame
    && ['xhr', 'fetch'].includes(resourceType) && expected
    && validRexxTimeZoneHeaders(headers)
    && Buffer.isBuffer(body) && body.length > 0 && body.length <= 256
    && (!headers['content-length'] || body.length === Number(headers['content-length']))
    && body.toString('utf8') === expected);
}

function validTimeZoneIdentifier(value) {
  return typeof value === 'number' ? Number.isSafeInteger(value) && value >= 0
    : typeof value === 'string' && value === value.trim() && /^[A-Za-z0-9_./:+() -]{1,128}$/.test(value);
}

/** Constant schema diagnostics only; never include response fields or values. */
export function rexxTimeZoneResponseReason(response) {
  if (response?.status !== 200) return 'http_status_unknown';
  if (!Buffer.isBuffer(response.body) || response.body.length > 2048) return 'response_size_unknown';
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers?.['content-type'] || '')) return 'response_not_json';
  try {
    const value = JSON.parse(response.body.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'response_shape_unknown';
    if (Object.keys(value).sort().join(',') !== 'id,success') return 'response_keys_unknown';
    if (value.success !== true) return 'response_success_unknown';
    return validTimeZoneIdentifier(value.id) ? 'response_duplicate_keys' : 'response_identifier_unknown';
  } catch { return 'response_json_unknown'; }
}

export function validRexxTimeZoneResponse(response) {
  if (response?.status !== 200 || !Buffer.isBuffer(response.body) || response.body.length > 2048
    || !/^application\/json(?:\s*;|$)/i.test(response.headers?.['content-type'] || '')) return false;
  try {
    const json = response.body.toString('utf8');
    const value = JSON.parse(json);
    const expression = syntax(`(${json})`).body[0]?.expression;
    const keys = expression?.type === 'ObjectExpression' ? expression.properties.map(property => keyOf(property)) : [];
    return keys.length === 2 && keys.sort().join(',') === 'id,success' && value && !Array.isArray(value) && Object.keys(value).sort().join(',') === 'id,success'
      && value.success === true && validTimeZoneIdentifier(value.id);
  } catch { return false; }
}
