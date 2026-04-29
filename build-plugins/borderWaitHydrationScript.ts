/**
 * Border-wait hydration script (F8) — vanilla-JS IIFE injected inline into
 * every static HTML page emitted by `borderWaitPagesPlugin.ts`.
 *
 * Why:
 *   The static pages are pre-rendered at build time from the
 *   `data/border-wait-current.json` snapshot, which can be 4–8 hours stale
 *   between deploys. The cron-scheduled traffic collector writes fresh
 *   per-crossing wait-times to the Firestore `trafficCurrent` collection
 *   every 15 minutes during commuter peaks. This script bridges the gap:
 *   on first JS run it asks Firestore (via the public REST endpoint) for
 *   the latest snapshot and overwrites the rendered numbers in place.
 *
 * Design constraints:
 *   - No Firebase SDK — keeps payload tiny (the firebase chunk is ~570 KB
 *     and is only loaded after first user interaction; the hydration must
 *     run during/before LCP without that cost).
 *   - Pre-rendered numbers stay in HTML for SEO/bots/zero-JS users.
 *   - Hard ceiling: 3 KB minified per CLAUDE.md text-to-HTML ratio gate.
 *   - Silent failure: on any error the pre-rendered values stay; we only
 *     emit a single `console.warn` for debugging.
 *
 * Doc shape on Firestore (written by `functions/src/trafficSchedulerCore.js
 * #saveTrafficToFirestore`):
 *   trafficCurrent/{slug} = {
 *     crossingName, waitTimeMinutes, approachMinutes, totalCrossingMinutes,
 *     status: 'green'|'yellow'|'red', direction, source, lastUpdate (Timestamp),
 *     hour, dayOfWeek
 *   }
 *
 * The `{slug}` produced by `slugifyCrossingName()` matches the plugin's
 * `BORDER_WAIT_CROSSINGS` slugs 1:1 for the 22 active crossings (the 2
 * inactive ones — `maslianico-roggiana`, `rodero-stabio` — keep their
 * pre-rendered fallback).
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

// Public, non-secret Firebase Web API key (same value baked into
// services/firebase.ts; obfuscated on the client only to discourage casual
// scraping — it is exposed in every Firestore REST request anyway).
const FIREBASE_PUBLIC_API_KEY = 'AIzaSyCxbA2_3BiBOjZryR5LOXCf_c2-Sgg7YSc';
const FIREBASE_PROJECT_ID = 'frontaliere-ticino';

/**
 * The IIFE payload. Kept as a single template string so the build plugin can
 * inline it verbatim inside `<script>...</script>`. We strip leading
 * whitespace + comments to keep the bundle under the 3 KB hard ceiling.
 */
const RAW_HYDRATION_JS = `
(function(){
  var K="${FIREBASE_PUBLIC_API_KEY}";
  var P="${FIREBASE_PROJECT_ID}";
  var URL="https://firestore.googleapis.com/v1/projects/"+P+"/databases/(default)/documents/trafficCurrent?key="+K+"&pageSize=50";
  var STALE_MS=2*60*60*1000;
  function warn(m){try{console.warn("[bw-hydrate] "+m)}catch(e){}}
  function pickInt(f){return f&&typeof f.integerValue==="string"?parseInt(f.integerValue,10):f&&typeof f.doubleValue==="number"?Math.round(f.doubleValue):null}
  function pickStr(f){return f&&typeof f.stringValue==="string"?f.stringValue:null}
  function pickTs(f){if(!f||!f.timestampValue)return null;var t=Date.parse(f.timestampValue);return isFinite(t)?t:null}
  function fmtClock(ms){try{var d=new Date(ms);var h=("0"+d.getHours()).slice(-2);var m=("0"+d.getMinutes()).slice(-2);return h+":"+m}catch(e){return ""}}
  function statusWord(s){return s==="green"?"breve":s==="yellow"?"moderata":s==="red"?"lunga":"—"}
  function applyToContainer(el,d){
    var fields=el.querySelectorAll("[data-bw-field]");
    for(var i=0;i<fields.length;i++){
      var f=fields[i];
      var key=f.getAttribute("data-bw-field");
      if(key==="waitTimeMinutes"&&d.wait!=null)f.textContent=d.wait+" min";
      else if(key==="totalCrossingMinutes"&&d.total!=null)f.textContent=d.total+" min";
      else if(key==="status"&&d.status)f.textContent=statusWord(d.status);
      else if(key==="lastUpdate"&&d.lastUpdate)f.textContent=fmtClock(d.lastUpdate);
    }
    el.setAttribute("data-bw-hydrated","true");
    if(el.classList)el.classList.add("bw-live");
  }
  function applyBadge(latestMs){
    var b=document.querySelector("[data-bw-live-badge]");
    if(!b)return;
    b.textContent="live (Firestore, agg. "+fmtClock(latestMs)+")";
    b.setAttribute("data-bw-live","true");
  }
  function run(){
    if(typeof fetch!=="function")return;
    fetch(URL,{credentials:"omit",mode:"cors"}).then(function(r){
      if(!r.ok)throw new Error("HTTP "+r.status);
      return r.json();
    }).then(function(j){
      var docs=j&&j.documents;
      if(!docs||!docs.length){warn("empty trafficCurrent");return}
      var now=Date.now();
      var freshest=0;
      var byslug={};
      for(var i=0;i<docs.length;i++){
        var doc=docs[i];
        var name=doc.name||"";
        var slug=name.split("/").pop();
        var f=doc.fields||{};
        var lu=pickTs(f.lastUpdate);
        if(!lu||now-lu>STALE_MS)continue;
        if(lu>freshest)freshest=lu;
        byslug[slug]={
          wait:pickInt(f.waitTimeMinutes),
          total:pickInt(f.totalCrossingMinutes),
          status:pickStr(f.status),
          lastUpdate:lu
        };
      }
      var fresh=0;
      var nodes=document.querySelectorAll("[data-bw-crossing]");
      for(var k=0;k<nodes.length;k++){
        var el=nodes[k];
        var slug=el.getAttribute("data-bw-crossing");
        var d=byslug[slug];
        if(!d)continue;
        applyToContainer(el,d);
        fresh++;
      }
      if(fresh>0&&freshest>0)applyBadge(freshest);
      else if(fresh===0)warn("no matching slugs for "+nodes.length+" elements");
    }).catch(function(e){warn(String(e&&e.message||e))});
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",run);
  else run();
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
 * `trafficCurrent` collection. Inject directly inside `<script>...</script>`.
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
 * script. Use this — NOT the inline `<script>${...}</script>` form — to keep
 * the SEO text-to-HTML ratio gate happy (CLAUDE.md hard rule). Pages share
 * one cached JS file across the whole F8 page family.
 */
export const BORDER_WAIT_HYDRATION_SCRIPT_TAG: string =
  `<script src="${BORDER_WAIT_HYDRATION_ASSET_PATH}" defer></script>`;
