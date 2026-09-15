/**
 * Border-wait hydration script (F8) — vanilla-JS IIFE emitted once as a
 * shared external asset and referenced by every static HTML page emitted by
 * `borderWaitPagesPlugin.ts`.
 *
 * Why:
 *   The static pages are pre-rendered at build time from the
 *   `data/border-wait-current.json` snapshot, which can be 4–8 hours stale
 *   between deploys. The cron-scheduled traffic collector writes fresh
 *   per-crossing wait-times to the Firestore `trafficCurrent` collection
 *   every 15 minutes during commuter peaks. This script bridges the gap:
 *   on first JS run it asks a read-only Cloud Function for the latest snapshot
 *   and overwrites the rendered numbers in place. It refreshes every 15 minutes
 *   while visible and resumes when the tab returns.
 *
 * Design constraints:
 *   - No Firebase SDK — keeps payload tiny (the firebase chunk is ~570 KB
 *     and is only loaded after first user interaction; the hydration must
 *     run during/before LCP without that cost).
 *   - Pre-rendered numbers stay in HTML for SEO/bots/zero-JS users.
 *   - The HTML contract stays tiny: pages load this shared external asset with
 *     a short `<script src>` tag, so the payload is cached and excluded from
 *     the per-page text-to-HTML ratio.
 *   - Silent failure: on any error the pre-rendered values stay; we only
 *     emit a single `console.warn` for debugging.
 *
 * Response shape from `functions/src/publicTrafficCurrent.js` (which reads the
 * same Firestore documents through Admin SDK):
 *   trafficCurrent/{slug} = {
 *     crossingName, waitTimeMinutes, approachMinutes, totalCrossingMinutes,
 *     status: 'green'|'yellow'|'red', source, lastUpdate (Timestamp),
 *     hour, dayOfWeek
 *   }
 *
 * The `{slug}` produced by `slugifyCrossingName()` matches the plugin's
 * `BORDER_WAIT_CROSSINGS` slugs 1:1. Crossings with no live reading in
 * `data/border-wait-current.json` (currently `maslianico-roggiana` and
 * `rodero-stabio`) keep their pre-rendered fallback — the count is derived
 * from the data, not a number to maintain here; it read "22 active" until
 * #4545 and was already stale by more than 100 crossings.
 *
 * DOM contract (in pages emitted by `borderWaitPagesPlugin.ts`):
 *
 *   - Container element marking a single crossing's row/card:
 *       <element data-bw-crossing="{slug}">…</element>
 *
 *   - Inside that container, one or more text-bearing elements per metric:
 *       <element data-bw-field="waitTimeMinutes">{n} min</element>
 *       <element data-bw-field="totalCrossingMinutes">{n} min</element>
 *       <element data-bw-field="status">…</element>
 *       <element data-bw-field="lastUpdate">…</element>
 *
 *   - One page-level live badge, optional:
 *       <element data-bw-live-badge>snapshot di {ts}</element>
 *
 *   On hydration success: container gains `data-bw-hydrated="true"` and
 *   class `bw-live`; field text is replaced.
 */


/**
 * The IIFE payload. Kept as a single template string so the build plugin can
 * emit it verbatim as the shared external asset. We strip leading whitespace
 * and blank lines to keep the asset compact.
 */
const RAW_HYDRATION_JS = `
(function(){
var U="https://europe-west6-frontaliere-ticino.cloudfunctions.net/getTrafficCurrent",S=7200000,R=900000,L=(document.documentElement.lang||"it").slice(0,2),T=null,B=0;
 L=/^(it|en|de|fr)$/.test(L)?L:"it";
 var C={it:{live:"live (Firestore, agg. ",offline:"snapshot — dato live non disponibile",stale:"snapshot — lettura live non disponibile",na:"non disponibile",g:"Scorrevole",y:"Moderata",r:"Lunga"},en:{live:"live (Firestore, upd. ",offline:"snapshot — live data unavailable",stale:"snapshot — no fresh live reading",na:"unavailable",g:"Free-flowing",y:"Moderate",r:"Long"},de:{live:"live (Firestore, akt. ",offline:"Snapshot — Live-Daten nicht verfügbar",stale:"Snapshot — keine aktuelle Live-Messung",na:"nicht verfügbar",g:"Fliessend",y:"Moderat",r:"Lang"},fr:{live:"live (Firestore, maj. ",offline:"instantané — données live indisponibles",stale:"instantané — aucune mesure live récente",na:"indisponible",g:"Fluide",y:"Modérée",r:"Longue"}}[L]||null;
function w(m){try{console.warn("[bw-hydrate] "+m)}catch(e){}}
function n(f){return f&&typeof f.integerValue==="string"?parseInt(f.integerValue,10):f&&typeof f.doubleValue==="number"?Math.round(f.doubleValue):null}
function s(f){return f&&typeof f.stringValue==="string"?f.stringValue:null}
function t(f){var x=f&&f.timestampValue?Date.parse(f.timestampValue):NaN;return isFinite(x)?x:null}
function clock(x){var d=new Date(x);return ("0"+d.getHours()).slice(-2)+":"+("0"+d.getMinutes()).slice(-2)}
function stat(x){return x==="green"?C.g:x==="yellow"?C.y:x==="red"?C.r:"—"}
 function set(el,d){var f=el.querySelectorAll("[data-bw-field]"),missing=!d;for(var i=0;i<f.length;i++){var a=f[i],k=a.getAttribute("data-bw-field"),v=k==="waitTimeMinutes"?d&&d.wait:d&&d.total!=null?d.total:d&&d.wait;if(missing){a.textContent=k==="source"||k==="status"||k==="waitTimeMinutes"||k==="totalCrossingMinutes"?C.na:"—";continue}if(k==="waitTimeMinutes"||k==="totalCrossingMinutes")a.textContent=v!=null?v+" min":C.na;else if(k==="status")a.textContent=stat(d.status);else if(k==="lastUpdate")a.textContent=clock(d.lastUpdate);else if(k==="source"){var m={};try{m=JSON.parse(a.getAttribute("data-bw-source-labels")||"{}")}catch(e){}a.textContent=d.source?m[d.source]||d.source:C.na}}el.setAttribute("data-bw-hydrated","true");el.setAttribute("data-bw-data-state",missing?"unavailable":"live");if(el.classList)el.classList.toggle("bw-live",!missing)}
function badge(kind,x){var b=document.querySelector("[data-bw-live-badge]");if(!b)return;b.textContent=kind==="live"?C.live+clock(x)+")":kind==="stale"?C.stale:C.offline;b.setAttribute("data-bw-live",kind==="live"?"true":"false");b.setAttribute("data-bw-fetch-state",kind)}
function pages(){return fetch(U,{credentials:"omit",mode:"cors"}).then(function(r){if(!r.ok)throw Error("HTTP "+r.status);return r.json()}).then(function(j){if(!j||!Array.isArray(j.documents))throw Error("invalid trafficCurrent");return j.documents})}
 function run(){if(typeof fetch!=="function"||T||document.hidden)return;T=true;pages().then(function(docs){var now=Date.now(),fresh=0,latest=0,map={};for(var i=0;i<docs.length;i++){var d=docs[i],f=d.fields||{},lu=t(f.lastUpdate);if(!lu||now-lu>S)continue;var q=d.name||"",slug=q.split("/").pop();map[slug]={wait:n(f.waitTimeMinutes),total:n(f.totalCrossingMinutes),status:s(f.status),source:s(f.source),lastUpdate:lu};if(lu>latest)latest=lu}var els=document.querySelectorAll("[data-bw-crossing]");for(var k=0;k<els.length;k++){var e=els[k],v=map[e.getAttribute("data-bw-crossing")];set(e,v);if(v)fresh++}if(fresh&&latest)badge("live",latest);else badge("stale");B=Date.now();T=false;clearTimeout(window.__bwTimer);window.__bwTimer=setTimeout(run,R)}).catch(function(e){T=false;badge("offline");w(String(e&&e.message||e));clearTimeout(window.__bwTimer);window.__bwTimer=setTimeout(run,R)})}
document.addEventListener("visibilitychange",function(){if(!document.hidden&&Date.now()-B>=R)run()});document.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest("[data-bw-picker-go]");if(b){var p=b.parentNode.parentNode.querySelector("[data-bw-picker-select]");if(p&&p.value)location.href=p.value}});if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",run);else run()
})();
`;

/** Minify: strip leading whitespace and blank lines (no closure compiler — keep cheap). */
function minify(src: string): string {
  return src
    .split('\n')
    .map((l) => l.replace(/^\s+/, ''))
    .filter((l) => l.length > 0 && !l.startsWith('//'))
    .join('');
}

/**
 * Self-contained vanilla JS IIFE that hydrates every
 * `[data-bw-crossing="{slug}"]` element on the page from the Firestore
 * `trafficCurrent` collection. Emitted once as `/border-wait-hydrate.js`.
 */
export const BORDER_WAIT_HYDRATION_JS: string = minify(RAW_HYDRATION_JS);

/**
 * External-asset filename. The plugin emits the IIFE as a static file at this
 * path under `dist/` and references it via `<script src defer>` so the inline
 * payload doesn't count against the per-page text-to-HTML ratio gate.
 */
export const BORDER_WAIT_HYDRATION_ASSET_PATH = '/border-wait-hydrate.js';

/**
 * `<script src=... defer>` tag (~70 bytes) that loads the external hydration
 * script. Pages share one cached JS file across the whole F8 page family.
 */
export const BORDER_WAIT_HYDRATION_SCRIPT_TAG: string =
  `<script src="${BORDER_WAIT_HYDRATION_ASSET_PATH}" defer></script>`;
