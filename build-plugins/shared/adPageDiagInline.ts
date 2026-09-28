/**
 * ES5 twin of services/adPageDiag.ts `startAdPageDiag()` for the static
 * AdSense loader (ADSENSE_LOADER_CONTENT in build-plugins/constants.ts).
 *
 * `AD_PAGE_DIAG_FN` is a function-expression string `function(isBot)`, like
 * BOT_GATE_FN: the loader calls it once, before its no-ads and bot-gate early
 * returns, so those page views are reported too (`ad_path`). Every literal it
 * shares with the SPA is interpolated from the TS source — the page-template
 * rules, storage keys, consent values, the consent-change event, the delay
 * and the event name — so only the control flow is re-expressed here.
 * tests/ad-page-diag-parity.test.ts runs this collector and the TS one on the
 * same DOM and requires identical parameters, and pins the once-per-page-view
 * behaviour of both.
 *
 * `window.__ftAdDiag` is the shared hand-off: the static page's first page view
 * is started here; when the SPA hydrates it finds the same path already taken
 * and steps aside, and on its first route change it calls this handle's
 * `flush(1)` before starting its own.
 */
import {
  ADS_CONSENT_CHANGE_EVENT,
  ADS_CONSENT_DENIED,
  ADS_CONSENT_GRANTED,
  ADS_CONSENT_STORAGE_KEY,
} from '../../services/adsConsent';
import {
  AD_PAGE_DIAG_DELAY_MS,
  AD_PAGE_DIAG_EVENT,
  FC_CONSENT_ROOT_SELECTOR,
} from '../../services/adPageDiag';
import { AD_BANNER_STATE_ATTR } from '../../services/adsenseSlots';
import { AD_PAGE_TEMPLATE_INLINE_FN } from '../../services/adPageTemplate';
import { READER_NOADS_ACTIVE_KEY } from '../../services/readerEntitlement';

const COLLECT_JS =
  `function collect(hidden){var ls=function(k){try{return w.localStorage.getItem(k);}catch(e){return null;}};` +
  `var c=ls('${ADS_CONSENT_STORAGE_KEY}'),consent=c==='${ADS_CONSENT_GRANTED}'?'granted':c==='${ADS_CONSENT_DENIED}'?'denied':'none';` +
  `var path=ls('${READER_NOADS_ACTIVE_KEY}')==='true'?'noads_entitlement':isBot()?'bot_gated':consent==='none'?'waiting_consent':'loaded';` +
  `var a=w.adsbygoogle,g=w.googlefc,o=w.__ftOfferwallGate,s=o?o.state:undefined;` +
  `var gate=(s==='held'&&typeof o.release==='function')||s==='released'||s==='suppressed'||s==='off_board'?s:'absent';` +
  `var ins=d.querySelectorAll('ins.adsbygoogle'),tot=0,fil=0,unf=0,col=0;` +
  `for(var i=0;i<ins.length;i++){var el=ins[i];if(!el.hasAttribute('data-ad-slot')||el.hasAttribute('data-anchor-status')||el.hasAttribute('data-vignette-loaded')||el.closest('.google-auto-placed'))continue;tot++;var st=el.getAttribute('data-ad-status');if(st==='filled')fil++;else if(st==='unfilled')unf++;if(el.hasAttribute('data-ft-static-ad-collapsed')||el.closest('[${AD_BANNER_STATE_ATTR}="collapsed"]'))col++;}` +
  `var an=d.querySelector('ins[data-anchor-status]');` +
  `return{page_template:(${AD_PAGE_TEMPLATE_INLINE_FN})(h.path,d),consent_state:consent,ad_path:path,` +
  `adsbygoogle_loaded:a&&(a.loaded===true||(typeof a.push==='function'&&a.push!==Array.prototype.push))?1:0,` +
  `fc_loaded:(g&&(typeof g.getAdBlockerStatus==='function'||typeof g.showRevocationMessage==='function'))||typeof w.__tcfapi==='function'?1:0,` +
  `gate_status:gate,slots_total:tot,slots_filled:fil,slots_unfilled:unf,slots_collapsed:col,` +
  `anchor_status:an?(String(an.getAttribute('data-anchor-status')||'').toLowerCase().replace(/[^a-z0-9_-]/g,'').slice(0,40)||'none'):'none',` +
  `vignette_ready:d.querySelector('ins[data-vignette-loaded="true"]')?1:0,` +
  `auto_placed:d.querySelectorAll('.google-auto-placed').length,first_fill_ms:h.ff,` +
  `cmp_shown:h.cmp||d.querySelector('${FC_CONSENT_ROOT_SELECTOR}')?1:0,` +
  `ad_blocked:w.__ftAdBlock&&w.__ftAdBlock.blocked===true?1:0,diag_hidden:hidden};}`;

const SEND_JS =
  `function send(p){p.transport_type='beacon';if(typeof w.gtag==='function'){w.gtag('event','${AD_PAGE_DIAG_EVENT}',p);return;}` +
  `var q=w.dataLayer=w.dataLayer||[];(function(){q.push(arguments);})('event','${AD_PAGE_DIAG_EVENT}',p);}`;

export const AD_PAGE_DIAG_FN =
  `function(isBot){try{var w=window,d=document,cur=w.__ftAdDiag,p=String(w.location.pathname);if(cur&&cur.path===p)return;` +
  `if(cur&&!cur.done){try{cur.flush(1);}catch(e){}}` +
  `var now=function(){try{return w.performance.now();}catch(e){return 0;}},t0=cur?now():0,offs=[];` +
  `var h={path:p,done:false,ff:-1,cmp:0};` +
  `var noteCmp=function(){if(d.querySelector('${FC_CONSENT_ROOT_SELECTOR}'))h.cmp=1;};noteCmp();` +
  `if(typeof MutationObserver!=='undefined'){` +
  `var fo=new MutationObserver(function(rs){for(var i=0;i<rs.length;i++){var t=rs[i].target;if(t.tagName==='INS'&&t.getAttribute('data-ad-status')==='filled'){h.ff=Math.max(0,Math.round(now()-t0));fo.disconnect();return;}}});` +
  `fo.observe(d.documentElement,{subtree:true,attributes:true,attributeFilter:['data-ad-status']});offs.push(function(){fo.disconnect();});` +
  `if(d.body){var co=new MutationObserver(function(){noteCmp();if(h.cmp)co.disconnect();});co.observe(d.body,{childList:true});offs.push(function(){co.disconnect();});}}` +
  `var onC=function(){h.cmp=1;},onS=function(e){if(e.key===null||e.key==='${ADS_CONSENT_STORAGE_KEY}')h.cmp=1;};` +
  `w.addEventListener('${ADS_CONSENT_CHANGE_EVENT}',onC);w.addEventListener('storage',onS);` +
  `offs.push(function(){w.removeEventListener('${ADS_CONSENT_CHANGE_EVENT}',onC);w.removeEventListener('storage',onS);});` +
  `${COLLECT_JS}${SEND_JS}h.collect=collect;` +
  `h.flush=function(hidden){if(h.done)return;h.done=true;for(var i=0;i<offs.length;i++)try{offs[i]();}catch(e){}try{send(collect(hidden));}catch(e){}};` +
  `var tm=setTimeout(function(){h.flush(0);},${AD_PAGE_DIAG_DELAY_MS});offs.push(function(){clearTimeout(tm);});` +
  `var onV=function(){if(d.visibilityState==='hidden')h.flush(1);},onH=function(){h.flush(1);};` +
  `d.addEventListener('visibilitychange',onV);w.addEventListener('pagehide',onH);` +
  `offs.push(function(){d.removeEventListener('visibilitychange',onV);w.removeEventListener('pagehide',onH);});` +
  `w.__ftAdDiag=h;}catch(e){}}`;
