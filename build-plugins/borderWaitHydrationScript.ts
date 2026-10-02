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
 *   On hydration: container gains `data-bw-hydrated="true"` and
 *   `data-bw-data-state="live|stale|unavailable"`; field text is replaced. The
 *   container's `class` is never touched: the containers are table rows,
 *   status cards and map list items whose layout comes from their own markup,
 *   and `.bw-live` is the live badge pill in `seo-static.css` — toggling it on
 *   the containers turned every hydrated row into an inline-flex uppercase pill.
 *
 *   - Inside a container, tone-painted elements repaint with the live wait
 *     (thresholds and tokens from `borderWaitTone.ts`, shared with the build):
 *       <element data-bw-tone-bg>  → background + border colour
 *       <element data-bw-tone-fg>  → text colour
 *     and `<element data-bw-unless-live>` (snapshot-only notices) is hidden
 *     once the crossing has a fresh reading.
 *
 *   - Present-tense status blocks rendered by `renderLiveSwap`:
 *       <div data-bw-swap="hub|advice" [data-bw-for="{slug}"]>
 *         <div data-bw-swap-out>…build-time variant…</div>
 *         <template data-bw-state="…">…</template> (one per variant)
 *       </div>
 *     The script picks the state the live readings call for — hub: fastest /
 *     fluid / fluid-measured / unavailable over the page's crossings; advice:
 *     ok / warn / bad / unavailable for `data-bw-for` — clones that template
 *     into `[data-bw-swap-out]` and fills its `[data-bw-slot]` values.
 */

import {
  BORDER_WAIT_OK_BELOW_MINUTES,
  BORDER_WAIT_TONE_COLORS,
  BORDER_WAIT_WARN_BELOW_MINUTES,
} from './borderWaitTone';


import { BORDER_WAIT_SOURCE_URLS } from './borderWaitSourceUrls';
import { BORDER_READING_MAX_AGE_MS } from '../services/dataFreshness';

/**
 * The IIFE payload. Kept as a single template string so the build plugin can
 * emit it verbatim as the shared external asset. We strip leading whitespace
 * and blank lines to keep the asset compact.
 */
const RAW_HYDRATION_JS = `
(function(){
var U="https://europe-west6-frontaliere-ticino.cloudfunctions.net/getTrafficCurrent",S=${BORDER_READING_MAX_AGE_MS},P=${JSON.stringify(BORDER_WAIT_SOURCE_URLS)},R=900000,L=(document.documentElement.lang||"it").slice(0,2),T=null,B=0,M={};
 L=/^(it|en|de|fr)$/.test(L)?L:"it";
 var TC=${JSON.stringify(BORDER_WAIT_TONE_COLORS)};
 var C={it:{live:"Osservato: ",offline:"snapshot — dato live non disponibile",stale:"Dato scaduto: traffico attuale sconosciuto",na:"non disponibile",g:"Scorrevole",y:"Moderata",r:"Lunga"},en:{live:"Observed: ",offline:"snapshot — live data unavailable",stale:"Outdated reading: current traffic unknown",na:"unavailable",g:"Free-flowing",y:"Moderate",r:"Long"},de:{live:"Beobachtet: ",offline:"Snapshot — Live-Daten nicht verfügbar",stale:"Veraltete Messung: aktueller Verkehr unbekannt",na:"nicht verfügbar",g:"Fliessend",y:"Moderat",r:"Lang"},fr:{live:"Observé : ",offline:"instantané — données live indisponibles",stale:"Mesure périmée : trafic actuel inconnu",na:"indisponible",g:"Fluide",y:"Modérée",r:"Longue"}}[L]||null;
function w(m){try{console.warn("[bw-hydrate] "+m)}catch(e){}}
function n(f){var x=f&&typeof f.integerValue==="string"?parseInt(f.integerValue,10):f&&typeof f.doubleValue==="number"?Math.round(f.doubleValue):null;return x!=null&&isFinite(x)?x:null}
function s(f){return f&&typeof f.stringValue==="string"?f.stringValue:null}
function t(f){var x=f&&f.timestampValue?Date.parse(f.timestampValue):NaN;return isFinite(x)?x:null}
function clock(x){return new Intl.DateTimeFormat(L,{year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",timeZone:"Europe/Zurich",timeZoneName:"short"}).format(new Date(x))}
function stat(x){return x==="green"?C.g:x==="yellow"?C.y:x==="red"?C.r:"—"}
function val(d){var v=d?(d.total!=null?d.total:d.wait):null;return d&&d.state==="live"&&Date.now()-d.lastUpdate<=S&&v!=null&&v>=0?v:null}
function tone(v){return v==null?"unknown":v<${BORDER_WAIT_OK_BELOW_MINUTES}?"ok":v<${BORDER_WAIT_WARN_BELOW_MINUTES}?"warn":"bad"}
function paint(el,v){var c=TC[tone(v)],b=el.querySelectorAll("[data-bw-tone-bg]"),g=el.querySelectorAll("[data-bw-tone-fg]"),i;for(i=0;i<b.length;i++){b[i].style.background=c.bg;b[i].style.borderColor=c.border}for(i=0;i<g.length;i++)g[i].style.color=c.text}
function slot(o,k){return o.querySelector('[data-bw-slot="'+k+'"]')}
function swap(h,st,fill){var p=h.querySelector('template[data-bw-state="'+st+'"]'),o=h.querySelector("[data-bw-swap-out]");if(!p||!p.content||!o)return;o.textContent="";o.appendChild(p.content.cloneNode(true));h.setAttribute("data-bw-swap-state",st);if(fill)fill(o)}
function hub(map){var h=document.querySelector('[data-bw-swap="hub"]');if(!h)return;var els=document.querySelectorAll("[data-bw-crossing]"),seen={},tot=0,m=0,pos=false,best=null,bv=0;for(var i=0;i<els.length;i++){var sl=els[i].getAttribute("data-bw-crossing");if(seen[sl])continue;seen[sl]=1;tot++;var v=val(map[sl]);if(v==null||v<0)continue;m++;if(v>0)pos=true;if(best===null||v<bv){best=els[i];bv=v}}var st=pos?"fastest":m&&m===tot?"fluid":m?"fluid-measured":"unavailable";swap(h,st,function(o){if(st==="fastest"){var a=best.querySelector("a[href]"),l=slot(o,"link"),x=slot(o,"minutes");if(a&&l){l.textContent=a.textContent.trim();l.setAttribute("href",a.getAttribute("href"))}if(x)x.textContent=bv+" min"}else if(st==="fluid-measured"){var y=slot(o,"measured"),z=slot(o,"total");if(y)y.textContent=String(m);if(z)z.textContent=String(tot)}})}
function advice(map){var h=document.querySelector('[data-bw-swap="advice"]');if(!h)return;var v=val(map[h.getAttribute("data-bw-for")]);swap(h,v==null?"unavailable":tone(v))}
function present(el,d){var v=val(d);paint(el,v);var u=el.querySelectorAll("[data-bw-unless-live]");for(var j=0;j<u.length;j++)u[j].hidden=v!=null}
function set(el,d,labels){var f=el.querySelectorAll("[data-bw-field]"),missing=!d;for(var i=0;i<f.length;i++){var a=f[i],k=a.getAttribute("data-bw-field"),v=k==="waitTimeMinutes"?d&&d.wait:d&&d.total!=null?d.total:d&&d.wait;if(missing){a.textContent=k==="source"||k==="status"||k==="waitTimeMinutes"||k==="totalCrossingMinutes"?C.na:"—";if(k==="source")a.removeAttribute("href");if(k==="lastUpdate")a.removeAttribute("datetime");continue}if(k==="waitTimeMinutes"||k==="totalCrossingMinutes")a.textContent=v!=null?v+" min":C.na;else if(k==="status")a.textContent=d.state==="stale"?C.stale:stat(d.status);else if(k==="lastUpdate"){a.textContent=clock(d.lastUpdate)+(d.state==="stale"?" · "+C.stale:"");if(a.tagName==="TIME")a.setAttribute("datetime",new Date(d.lastUpdate).toISOString())}else if(k==="source"){a.textContent=d.source?(labels[d.source]||d.source)+" ("+d.source+")":C.na;if(a.tagName==="A"&&P[d.source])a.setAttribute("href",P[d.source]);else a.removeAttribute("href")}}present(el,d);el.setAttribute("data-bw-hydrated","true");el.setAttribute("data-bw-data-state",missing?"unavailable":d.state);if(d)el.setAttribute("data-bw-observed-at",String(d.lastUpdate));else el.removeAttribute("data-bw-observed-at")}
function badge(kind,x){var b=document.querySelector("[data-bw-live-badge]");if(!b)return;if(!b.hasAttribute("data-bw-original-badge"))b.setAttribute("data-bw-original-badge",b.textContent);if(x)b.setAttribute("data-bw-observed-at",String(x));var prior=Number(b.getAttribute("data-bw-observed-at"));b.textContent=kind==="live"?C.live+clock(x):kind==="stale"?C.stale+(x?" · "+C.live+clock(x):""):(prior?C.live+clock(prior)+(Date.now()-prior>S?" · "+C.stale:""):(b.getAttribute("data-bw-original-badge")||""))+" · "+C.offline;b.setAttribute("data-bw-live",kind==="live"?"true":"false");b.setAttribute("data-bw-fetch-state",kind)}
function expire(){var es=document.querySelectorAll("[data-bw-crossing][data-bw-observed-at]"),changed=false;for(var i=0;i<es.length;i++){var el=es[i],at=Number(el.getAttribute("data-bw-observed-at"));if(at&&Date.now()-at>S){el.setAttribute("data-bw-data-state","stale");present(el,null);var f=el.querySelector('[data-bw-field="lastUpdate"]');if(f)f.textContent=clock(at)+" · "+C.stale;changed=true}}if(changed){hub(M);advice(M)}}
function pages(){return fetch(U,{credentials:"omit",mode:"cors"}).then(function(r){if(!r.ok)throw Error("HTTP "+r.status);return r.json()}).then(function(j){if(!j||!Array.isArray(j.documents))throw Error("invalid trafficCurrent");return j.documents})}
 function run(){expire();if(typeof fetch!=="function"||T||document.hidden)return;T=true;pages().then(function(docs){var now=Date.now(),fresh=0,latest=0,map={},labels={},labelHost=document.querySelector("[data-bw-source-labels]");if(labelHost)try{labels=JSON.parse(labelHost.getAttribute("data-bw-source-labels")||"{}")}catch(e){}for(var i=0;i<docs.length;i++){var d=docs[i],f=d.fields||{},lu=t(f.lastUpdate);if(!lu||lu>now)continue;var q=d.name||"",slug=q.split("/").pop();map[slug]={wait:n(f.waitTimeMinutes),total:n(f.totalCrossingMinutes),status:s(f.status),source:s(f.source),lastUpdate:lu,state:now-lu>S?"stale":"live"}}var els=document.querySelectorAll("[data-bw-crossing]");for(var k=0;k<els.length;k++){var e=els[k],v=map[e.getAttribute("data-bw-crossing")];set(e,v,labels);if(v&&v.state==="live"){fresh++;if(v.lastUpdate>latest)latest=v.lastUpdate}}M=map;hub(map);advice(map);var b=document.querySelector("[data-bw-badge-crossing]"),target=b&&map[b.getAttribute("data-bw-badge-crossing")];if(b)badge(target?target.state:"stale",target&&target.lastUpdate);else if(fresh&&latest)badge("live",latest);else badge("stale");B=Date.now();T=false;clearTimeout(window.__bwTimer);window.__bwTimer=setTimeout(run,R)}).catch(function(e){T=false;expire();badge("offline");w(String(e&&e.message||e));clearTimeout(window.__bwTimer);window.__bwTimer=setTimeout(run,R)})}
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
