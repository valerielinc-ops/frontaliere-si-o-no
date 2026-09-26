import {
  ADS_CONSENT_CHANGE_EVENT,
  ADS_CONSENT_GRANTED,
  ADS_CONSENT_STORAGE_KEY,
} from '../services/adsConsent';
import { FC_JOBBOARD_OFFERWALL_GATE_JS } from './constants';
import { isJobBoardSectionPathname } from '../scripts/lib/jobBoardSections.mjs';

/** The GPT library required by Google Ad Manager Offerwall. */
export const GPT_SCRIPT_SRC = 'https://securepubads.g.doubleclick.net/tag/js/gpt.js';

/** Stable, cacheable bootstrap emitted only on job-board pages. */
export const GPT_LOADER_FILENAME = 'gpt-loader.js';

/** Synchronous bootstrap: it queues GPT before Funding Choices evaluates Offerwall. */
export const GPT_BOOTSTRAP_TAG = `<script src="/assets/${GPT_LOADER_FILENAME}"></script>`;

/**
 * Whether a URL belongs to a job-board section (every canton, the Switzerland
 * aggregator, every locale). Same shared matcher as the click-only Offerwall
 * gate and JobBoard's rewarded surface, so GPT is bootstrapped on exactly the
 * pages where "Candidati" runs the rewarded flow.
 */
export function isJobBoardPageUrl(value: string): boolean {
  let pathname = value;
  try {
    pathname = new URL(value, 'https://frontaliereticino.ch').pathname;
  } catch {
    pathname = value.split(/[?#]/, 1)[0] ?? value;
  }
  return isJobBoardSectionPathname(pathname);
}

const scriptSrc = JSON.stringify(GPT_SCRIPT_SRC);
const consentEvent = JSON.stringify(ADS_CONSENT_CHANGE_EVENT);
const consentKey = JSON.stringify(ADS_CONSENT_STORAGE_KEY);
const consentGranted = JSON.stringify(ADS_CONSENT_GRANTED);

/**
 * Static-page twin of the React GPT bootstrap.
 *
 * It does not request an ad or define a slot. It only loads GPT after the
 * explicit ads-consent decision and enables the shared framework so Offerwall
 * can detect GPT on first entry. The React slot components remain responsible
 * for lazy slot display.
 *
 * It starts with FC_JOBBOARD_OFFERWALL_GATE_JS. This file is synchronous and
 * can inject gpt.js during parsing, before the deferred adsense-loader.js
 * (the gate's usual carrier on these pages) runs; with AdSense covering the
 * whole site a Funding Choices instance reached through GPT must still find
 * the gate installed, or the Offerwall would show on entry. The gate is
 * idempotent: the first copy on the page installs it.
 */
export const GPT_LOADER_CONTENT = `${FC_JOBBOARD_OFFERWALL_GATE_JS}(function(){
  var SCRIPT_SRC=${scriptSrc};
  var CONSENT_EVENT=${consentEvent};
  var CONSENT_KEY=${consentKey};
  var CONSENT_GRANTED=${consentGranted};
  var requested=false;
  function hasConsent(){
    try{return window.localStorage.getItem(CONSENT_KEY)===CONSENT_GRANTED;}catch(e){return false;}
  }
  function ensure(){
    if(requested||!hasConsent()||typeof document==='undefined')return;
    requested=true;
    var tag=window.googletag=window.googletag||{};
    tag.cmd=tag.cmd||[];
    if(typeof tag.cmd.push!=='function')tag.cmd=[];
    if(!document.querySelector('script[src="'+SCRIPT_SRC+'"]')){
      var script=document.createElement('script');
      script.src=SCRIPT_SRC;
      script.async=true;
      script.crossOrigin='anonymous';
      document.head.appendChild(script);
    }
    tag.cmd.push(function(){
      if(tag.__frontaliereGptServicesEnabled)return;
      try{
        tag.setConfig({singleRequest:true,collapseDiv:'BEFORE_FETCH'});
        tag.enableServices();
        tag.__frontaliereGptServicesEnabled=true;
      }catch(e){}
    });
  }
  window.addEventListener(CONSENT_EVENT,ensure);
  window.addEventListener('storage',function(event){
    if(!event.key||event.key===CONSENT_KEY)ensure();
  });
  ensure();
}());
`;
