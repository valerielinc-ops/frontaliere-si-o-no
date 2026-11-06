/** Public bootstrap assets proven by active document tags or literal JS loaders. */
import { parse as parseHtml } from 'parse5';
import { parse } from 'acorn';

export function walkScriptAst(node, visit, parents = []) {
  if (!node || typeof node !== 'object' || !node.type) return;
  visit(node, parents);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const child of value) walkScriptAst(child, visit, [...parents, node]);
    else if (value?.type) walkScriptAst(value, visit, [...parents, node]);
  }
}
export function activePublicDocumentScripts(html, applyUrl) {
  const scripts = [];
  let baseUrl = applyUrl;
  let baseSeen = false;
  let language = '';
  const visit = node => {
    if (node.namespaceURI === 'http://www.w3.org/1999/xhtml') {
      const attrs = Object.fromEntries((node.attrs || []).map(attr => [attr.name, attr.value]));
      if (node.tagName === 'html') language = attrs.lang || '';
      if (node.tagName === 'base' && !baseSeen && attrs.href) {
        baseSeen = true;
        try { baseUrl = new URL(attrs.href, applyUrl).href; } catch { baseUrl = ''; }
      }
      if (node.tagName === 'script' && !Object.hasOwn(attrs, 'nomodule')
        && /^(?:|module|(?:text|application)\/(?:javascript|ecmascript))$/i.test((attrs.type || '').trim())) {
        scripts.push({ attrs, source: (node.childNodes || []).filter(child => child.nodeName === '#text').map(child => child.value).join('') });
      }
    }
    // Template.content and inert text are deliberately not traversed.
    for (const child of node.childNodes || []) visit(child);
  };
  try { visit(parseHtml(String(html))); } catch { return { scripts: [], baseUrl: '', language: '' }; }
  return { scripts, baseUrl, language };
}
const javascriptType = value => /^(?:text|application)\/(?:javascript|ecmascript)(?:\s*;|$)/i.test(value || '');
export const isPublicJavaScriptResponse = response => javascriptType(response?.headers?.['content-type']);
export function hasSafePublicScriptQuery(value) {
  try {
    const url = new URL(value);
    const keys = [...url.searchParams.keys()];
    return !url.username && !url.password && !url.hash && url.href.length <= 2000
      && new Set(keys).size === keys.length && keys.every(key => ['v', 'ver', 'version', '_'].includes(key)
        && (key === '_' ? /^\d{1,17}$/ : /^[a-z0-9._-]{1,40}$/i).test(url.searchParams.get(key)));
  } catch { return false; }
}

function staticScriptUrl(value, baseUrl, origin) {
  try {
    const url = new URL(value, baseUrl);
    if (url.origin !== origin || url.protocol !== 'https:' || url.username || url.password || url.hash
      || url.href.length > 2000 || !/\.m?js$/i.test(url.pathname)) return null;
    if (!hasSafePublicScriptQuery(url.href)) return null;
    return url.href;
  } catch { return null; }
}
export function literalScriptAssetUrls(source, baseUrl, origin) {
  if (String(source).length > 100_000) return [];
  const urls = [];
  try {
    walkScriptAst(parse(String(source), { ecmaVersion: 'latest', sourceType: 'script' }), node => {
      if (node.type !== 'CallExpression' || node.callee?.type !== 'MemberExpression' || node.callee.computed
        || !['$', 'jQuery'].includes(node.callee.object?.name)) return;
      let value;
      if (node.callee.property?.name === 'getScript' && node.arguments[0]?.type === 'Literal') value = node.arguments[0].value;
      if (node.callee.property?.name === 'ajax' && node.arguments[0]?.type === 'ObjectExpression') {
        const properties = node.arguments[0].properties;
        if (properties.some(property => property.type !== 'Property' || property.computed || property.kind !== 'init')) return;
        const pairs = properties.map(property => [property.key.name ?? property.key.value, property.value]);
        if (new Set(pairs.map(([key]) => key)).size !== pairs.length) return;
        const options = Object.fromEntries(pairs);
        if (options.data || options.body || options.headers || options.username || options.password
          || options.dataType?.value !== 'script' || options.url?.type !== 'Literal'
          || options.type && options.type.value !== 'GET' || options.method && options.method.value !== 'GET') return;
        value = options.url.value;
      }
      if (typeof value !== 'string') return;
      const url = staticScriptUrl(value, baseUrl, origin);
      if (url) urls.push(url);
    });
  } catch { return []; }
  return [...new Set(urls)];
}
export function matchesScriptAsset(url, expectedUrls) {
  try {
    const actual = new URL(url);
    if (actual.username || actual.password || actual.hash || !/\.m?js$/i.test(actual.pathname)) return false;
    for (const value of expectedUrls) {
      const expected = new URL(value);
      const normalized = new URL(actual);
      const cache = normalized.searchParams.getAll('_');
      if (cache.length > 1 || cache.length && !/^\d{1,17}$/.test(cache[0])) continue;
      if (cache.length && !expected.searchParams.has('_')) normalized.searchParams.delete('_');
      if (normalized.href === expected.href) return true;
    }
  } catch { /* Unknown identity grants no asset read. */ }
  return false;
}
export function publicAssetSources(html, applyUrl) {
  const document = activePublicDocumentScripts(html, applyUrl);
  const origin = new URL(applyUrl).origin;
  const scripts = [];
  const loaders = [];
  const oneTrust = [];
  for (const { attrs, source } of document.scripts) {
    if (!attrs.src) loaders.push(...literalScriptAssetUrls(source, document.baseUrl, origin));
    else {
      let url;
      try { url = new URL(attrs.src, document.baseUrl); } catch { continue; }
      scripts.push(url.href);
      if (url.origin === 'https://cdn.cookielaw.org' && url.pathname === '/scripttemplates/otSDKStub.js'
        && !url.search && !url.hash && !url.username && !url.password
        && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(attrs['data-domain-script'] || '')) {
        const id = attrs['data-domain-script'];
        const language = attrs['data-language'] || (attrs['data-document-language'] === 'true' ? document.language : '');
        const files = [id];
        if (/^[a-z]{2}(?:-[a-z]{2})?$/i.test(language)) files.push(language.toLowerCase());
        oneTrust.push({ language: /^[a-z]{2}(?:-[a-z]{2})?$/i.test(language) ? language.toLowerCase() : '', loaderUrl: url.href, configs: files.map(file => new URL(`/consent/${id}/${file}.json`, url.origin).href) });
      }
    }
  }
  const knownOneTrust = oneTrust.length === 1 ? oneTrust[0] : null;
  if (knownOneTrust) {
    const prefix = new URL(knownOneTrust.configs[0]);
    const autoBlock = new URL('OtAutoBlock.js', prefix).href;
    knownOneTrust.loaderUrls = [knownOneTrust.loaderUrl, ...scripts.filter(url => url === autoBlock)];
  }
  return { scripts, baseUrl: document.baseUrl, loaders: [...new Set(loaders)], oneTrust: knownOneTrust };
}
