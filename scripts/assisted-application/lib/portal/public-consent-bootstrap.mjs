/** Read-only consent assets and positively identified, aborted telemetry. */
import { parse } from 'acorn';
import { createHash } from 'node:crypto';
import { activePublicDocumentScripts, walkScriptAst } from './read-only-asset-contracts.mjs';
const ast = source => parse(source, { ecmaVersion: 'latest' });
function shape(value) {
  if (Array.isArray(value)) return value.map(shape);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => !['start', 'end', 'raw'].includes(key)).map(key => [key, shape(value[key])]));
}
const equal = (a, b) => JSON.stringify(shape(a)) === JSON.stringify(shape(b));
const telemetryTemplate = ast(`var _paq=window._paq||[];_paq.push(['disableCookies']);_paq.push(['trackPageView']);_paq.push(['enableLinkTracking']);(function(){var u='https://telemetry.example/';_paq.push(['setTrackerUrl',u+'matomo.php']);_paq.push(['setSiteId',1]);var d=document,g=d.createElement('script'),s=d.getElementsByTagName('script')[0];g.type='text/javascript';g.async=true;g.defer=true;g.src=u+'matomo.js';s.parentNode.insertBefore(g,s);})();`);
export function cookielessTelemetryProtocol(html, applyUrl) {
  const matches = [];
  for (const script of activePublicDocumentScripts(html, applyUrl).scripts) {
    if (script.attrs.src || script.source.length > 10_000) continue;
    try {
      const program = ast(script.source);
      const fn = program.body[4]?.expression?.callee;
      const origin = fn?.body?.body[0]?.declarations?.[0]?.init;
      const site = fn?.body?.body[2]?.expression?.arguments?.[0]?.elements?.[1];
      if (origin?.type !== 'Literal' || typeof origin.value !== 'string' || site?.type !== 'Literal'
        || !Number.isSafeInteger(site.value) || site.value < 1) continue;
      const base = new URL(origin.value, applyUrl);
      if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) continue;
      const original = origin.value;
      origin.value = 'https://telemetry.example/'; site.value = 1;
      if (!equal(program, telemetryTemplate)) continue;
      matches.push({ trackerUrl: new URL('matomo.php', base).href, scriptUrl: new URL('matomo.js', base).href,
        sourceHash: createHash('sha256').update(script.source).digest('hex') });
      origin.value = original;
    } catch { /* Unknown inline code never grants a nonfunctional classification. */ }
  }
  return matches.length === 1 ? matches[0] : null;
}
const geoCall = ast(`K.prototype.getGeoLocation=function(e){var t=this.getGeolocationURL(e);this.otFetch(t,this.geoLocationJsonCallback.bind(this,e),!0)}`).body[0].expression.right;
export function officialConsentGeoLoader(source) {
  let matches = 0;
  try {
    walkScriptAst(ast(source), node => {
      if (node.type === 'AssignmentExpression' && node.left?.type === 'MemberExpression'
        && !node.left.computed && node.left.property?.name === 'getGeoLocation' && equal(node.right, geoCall)) matches++;
    });
  } catch { return false; }
  return matches === 1;
}
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
export function derivedConsentPublicReads(config, sourceUrl, oneTrust, geoLoader) {
  if (!oneTrust || sourceUrl !== oneTrust.configs[0] || !config || Array.isArray(config)) return { configs: [], geo: null };
  const root = new URL(sourceUrl);
  const lang = oneTrust.language;
  const rules = Array.isArray(config.RuleSet) && config.RuleSet.length <= 32 ? config.RuleSet : [];
  const ids = rules.map(rule => rule?.Id);
  const configs = [];
  if (lang && ids.every(uuid) && new Set(ids).size === ids.length) {
    for (const rule of rules) {
      if (rule.LanguageSwitcherPlaceholder?.[lang] === lang) configs.push(new URL(`${rule.Id}/${lang}.json`, root).href);
    }
  }
  const geo = geoLoader && config.SkipGeolocation === false
    && config.GeolocationUrl === 'https://geolocation.onetrust.com/cookieconsentpub/v1/geo/location' ? config.GeolocationUrl : null;
  const sdkUrl = typeof config.Version === 'string' && /^\d{6}\.\d{1,3}\.\d{1,3}$/.test(config.Version)
    ? new URL(`/scripttemplates/${config.Version}/otBannerSdk.js`, root.origin).href : null;
  return { configs, geo, sdkUrl };
}

const assetsBase = ast(`s.prototype.getBannerSDKAssestsUrl=function(){return this.getBannerVersionUrl()+"/assets"}`).body[0].expression.right;
const versionBase = ast(`s.prototype.getBannerVersionUrl=function(){var e=_.bannerScriptElement.getAttribute("src");return ""+(-1!==e.indexOf("/consent/")?e.split("consent/")[0]+"scripttemplates/":e.split("otSDKStub")[0])+P.moduleInitializer.Version}`).body[0].expression.right;
export function officialConsentUiAssets(source, sourceUrl, expectedSdkUrl) {
  if (!expectedSdkUrl || sourceUrl !== expectedSdkUrl || source.length > 1_000_000) return [];
  const names = new Set(); const files = new Set(); let base = 0; let version = 0;
  try {
    walkScriptAst(ast(source), node => {
      if (node.type === 'AssignmentExpression' && !node.left?.computed) {
        if (node.left?.property?.name === 'getBannerSDKAssestsUrl' && equal(node.right, assetsBase)) base++;
        if (node.left?.property?.name === 'getBannerVersionUrl' && equal(node.right, versionBase)) version++;
      }
      if (node.type === 'VariableDeclarator' && node.init?.type === 'Literal'
        && typeof node.init.value === 'string' && /^ot[A-Za-z]{1,40}$/.test(node.init.value)) names.add(node.init.value);
      if (node.type === 'VariableDeclarator' && node.init?.type === 'Literal'
        && typeof node.init.value === 'string' && /^ot[A-Za-z]{1,40}\.json$/.test(node.init.value)) files.add(node.init.value);
      if (node.type === 'BinaryExpression' && node.operator === '+' && node.right?.value === '.css'
        && node.left?.type === 'BinaryExpression' && node.left.operator === '+'
        && node.left.right?.type === 'ConditionalExpression' && node.left.right.consequent?.value === 'Rtl'
        && node.left.right.alternate?.value === '' && node.left.left?.type === 'BinaryExpression'
        && node.left.left.operator === '+' && /^\/ot[A-Za-z]{1,40}$/.test(node.left.left.right?.value || '')
        && node.left.left.left?.type === 'CallExpression' && !node.left.left.left.arguments.length
        && node.left.left.left.callee?.type === 'MemberExpression' && !node.left.left.left.callee.computed
        && node.left.left.left.callee.property?.name === 'getBannerSDKAssestsUrl') {
        const name = node.left.left.right.value.slice(1);
        files.add(`${name}.css`); files.add(`${name}Rtl.css`);
      }
    });
  } catch { return []; }
  if (base !== 1 || version !== 1 || (!names.size && !files.size) || names.size + files.size > 64) return [];
  const urls = [...files].map(file => new URL(`assets/${file}`, expectedSdkUrl).href);
  for (const name of names) for (const prefix of ['', 'v2/']) for (const rtl of ['', 'Rtl']) {
    urls.push(new URL(`assets/${prefix}${name}${rtl}.json`, expectedSdkUrl).href);
  }
  return [...new Set(urls)];
}

const beaconSender = ast(`function bi(dU,dX,dW){var dS=aT();if(!dS){return false}var dT={type:"application/x-www-form-urlencoded; charset=UTF-8"};var dY=false;var dR=aM;try{var dQ=new Blob([dU],dT);if(dW&&!c6(dU)){dQ=new Blob([],dT);dR=dR+(dR.indexOf("?")<0?"?":"&")+dU}dY=g.sendBeacon(dR,dQ)}catch(dV){return false}if(dY&&typeof dX==="function"){dX({request:dU,trackerUrl:aM,success:true,isSendBeacon:true})}cL();return dY}`).body[0];
export function observationalBeaconQuerySender(source) {
  let matches = 0;
  try { walkScriptAst(ast(source), node => { if (node.type === 'FunctionDeclaration' && equal(node, beaconSender)) matches++; }); }
  catch { return false; }
  return matches === 1;
}
export function matchesObservationalTelemetry(protocol, value, querySender = false) {
  if (!protocol || typeof value !== 'string' || value.length > 32_000) return false;
  try {
    const actual = new URL(value); const expected = new URL(protocol.trackerUrl);
    return !actual.username && !actual.password && !actual.hash && actual.origin === expected.origin
      && actual.pathname === expected.pathname && (!actual.search || querySender);
  } catch { return false; }
}

const svgGetter = ast(`Zt.prototype.getPersistentCookieSvg=function(e){e=e||D.cookiePersistentLogo;return e?Xt.otFetch(e,!0):Promise.resolve(null)}`).body[0].expression.right;
export function officialConsentSvgGetter(source) {
  let matches = 0;
  try { walkScriptAst(ast(source), node => {
    if (node.type === 'AssignmentExpression' && !node.left?.computed
      && node.left?.property?.name === 'getPersistentCookieSvg' && equal(node.right, svgGetter)) matches++;
  }); } catch { return false; }
  return matches === 1;
}
export function consentPublicLogo(config, sdkGetter, sourceUrl, languageUrls = []) {
  const logo = 'https://cdn.cookielaw.org/logos/static/ot_guard_logo.svg';
  return sdkGetter && languageUrls.includes(sourceUrl) && config?.CommonData?.OTGuardLogo === logo ? logo : null;
}
