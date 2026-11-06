/** One fresh public guest SID, never a candidate/login cookie jar. */
import { CookieJar } from 'tough-cookie';
import { parse } from 'acorn';
import { createHash } from 'node:crypto';
import { activePublicDocumentScripts, walkScriptAst } from './read-only-asset-contracts.mjs';

const parseJs = source => parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
const key = property => !property.computed && (property.key?.name ?? property.key?.value);
function signature(value) {
  if (Array.isArray(value)) return value.map(signature);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter(name => !['start', 'end', 'raw'].includes(name)).map(name => [name,
    name === 'key' && value.type === 'Property' && key(value) ? { type: 'StaticKey', name: String(key(value)) } : signature(value[name])]));
}
const template = parseJs(`$.ajax({url:base_url_rexx+'cookiecheck-cc0.html'+(session_id===''?'':'?'+session_name+'='+session_id),async:false,method:'GET',dataType:'json',success:function(data){if(typeof data['cookie_allowed']!=='undefined'){upload.cookie_allowed=data['cookie_allowed'];upload.session_id=data['session_id'];}else{upload.cookie_allowed=false;}}});`).body[0].expression;
const expected = JSON.stringify(signature(template));

export function initialRexxGuestSession(html, applyUrl, setCookie, lookupUrl, onStatus = () => {}) {
  const fail = reason => { onStatus(reason); return null; };
  const page = new URL(applyUrl);
  if (page.protocol !== 'https:' || page.username || page.password
    || [...page.searchParams.keys()].some(name => /sid|session|token|auth|candidate|application/i.test(name))) return fail('private_document_context');
  const sessions = [];
  for (const script of activePublicDocumentScripts(html, applyUrl).scripts) {
    if (script.attrs.src || script.source.length > 100_000) continue;
    try {
      walkScriptAst(parseJs(script.source), node => {
        if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' && !node.callee.computed
          && node.callee.object?.name === 'upload' && node.callee.property?.name === 'InitChunckedUpload'
          && node.arguments[5]?.type === 'Literal' && node.arguments[6]?.type === 'Literal') {
          sessions.push({ name: node.arguments[5].value, value: node.arguments[6].value });
        }
      });
    } catch { return fail('page_script_unknown'); }
  }
  const unique = [...new Set(sessions.map(item => JSON.stringify(item)))];
  if (unique.length !== 1) return fail('page_session_ambiguous');
  const guest = JSON.parse(unique[0]);
  if (typeof guest.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(guest.name)
    || typeof guest.value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(guest.value)) return fail('page_session_shape_unknown');
  const lines = Array.isArray(setCookie) ? setCookie : typeof setCookie === 'string' ? [setCookie] : [];
  const matching = lines.filter(line => typeof line === 'string' && line.length <= 4096 && line.split('=', 1)[0].trim() === guest.name);
  if (!matching.length) return fail('initial_cookie_missing');
  // Repeated identical Set-Cookie headers define one RFC cookie, not two
  // guest identities. Different declarations remain ambiguous.
  if (matching.length > 8 || new Set(matching).size !== 1 || new URL(lookupUrl).origin !== page.origin) return fail('initial_cookie_ambiguous');
  try {
    const jar = new CookieJar(undefined, { rejectPublicSuffixes: true, allowSpecialUseDomain: false, prefixSecurity: 'strict' });
    jar.setCookieSync(matching[0], applyUrl);
    const cookies = jar.getCookiesSync(lookupUrl);
    if (cookies.length !== 1 || cookies[0].key !== guest.name || cookies[0].value !== guest.value) return fail('initial_cookie_mismatch');
    const cookie = cookies[0];
    onStatus('initial_cookie_matched');
    return { ...guest, origin: page.origin, expiresAt: cookie.expiryTime(),
      browserCookie: { name: guest.name, value: guest.value, domain: page.hostname, path: cookie.path,
        secure: true, httpOnly: Boolean(cookie.httpOnly), sameSite: cookie.sameSite === 'strict' ? 'Strict' : 'Lax',
        ...(Number.isFinite(cookie.expiryTime()) ? { expires: Math.floor(cookie.expiryTime() / 1000) } : {}) } };
  } catch { return fail('initial_cookie_scope_unknown'); }
}

export function rexxGuestSessionProtocol(sources, scriptUrl, bytes) {
  if (!sources || sources.scripts.filter(url => url === scriptUrl).length !== 1 || bytes.length > 100_000) return null;
  let matches = 0;
  try {
    walkScriptAst(parseJs(bytes.toString('utf8')), (node, parents) => {
      if (node.type !== 'CallExpression' || JSON.stringify(signature(node)) !== expected) return;
      const fn = [...parents].reverse().find(parent => parent.type === 'FunctionExpression');
      const owner = fn && parents[parents.indexOf(fn) - 1];
      if (fn?.params.map(param => param.name).join(',') === 'elem_id,handler,chunkSize,field_name,options,session_name,session_id'
        && owner?.type === 'Property' && key(owner) === 'InitChunckedUpload') matches++;
    });
  } catch { return null; }
  return matches === 1 ? { name: 'rexx-guest-cookie-check-v1', lookupUrl: new URL('cookiecheck-cc0.html', sources.lookupUrl).href,
    scriptUrl, scriptHash: createHash('sha256').update(bytes).digest('hex') } : null;
}

export function matchesRexxGuestProbe(protocol, guest, value, now = Date.now()) {
  if (!protocol || !guest || !(guest.expiresAt === Infinity || Number.isFinite(guest.expiresAt) && guest.expiresAt > now)) return false;
  try {
    const url = new URL(value);
    return url.origin === guest.origin && url.origin === new URL(protocol.lookupUrl).origin
      && url.pathname === new URL(protocol.lookupUrl).pathname && !url.username && !url.password && !url.hash
      && url.searchParams.size === 1 && url.searchParams.get(guest.name) === guest.value;
  } catch { return false; }
}

export function validRexxGuestResponse(response, guest) {
  if (response?.status !== 200 || !Buffer.isBuffer(response.body) || response.body.length > 4096
    || !/^application\/json(?:\s*;|$)/i.test(response.headers?.['content-type'] || '')) return false;
  try {
    const text = response.body.toString('utf8');
    const value = JSON.parse(text);
    const expression = parseJs(`(${text})`).body[0]?.expression;
    const keys = expression?.type === 'ObjectExpression' ? expression.properties.map(key) : [];
    return keys.length === 2 && keys.sort().join(',') === 'cookie_allowed,session_id'
      && value.cookie_allowed === true && value.session_id === guest.value;
  } catch { return false; }
}
