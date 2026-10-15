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

/** Stable, cacheable Funding Choices carrier for job-board pages. */
export const JOB_BOARD_FC_LOADER_FILENAME = 'job-board-fc-loader.js';
export const JOB_BOARD_FC_LOADER_TAG = `<script defer src="/assets/${JOB_BOARD_FC_LOADER_FILENAME}"></script>`;

/** Deferred bootstrap: it queues GPT before DOMContentLoaded without blocking parsing. */
export const GPT_BOOTSTRAP_TAG = `<script defer src="/assets/${GPT_LOADER_FILENAME}"></script>`;

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

/** The two ordered, deferred tags required by every statically emitted job-board page. */
export const JOB_BOARD_HEAD_TAGS = `\n ${GPT_BOOTSTRAP_TAG}\n ${JOB_BOARD_FC_LOADER_TAG}`;

/**
 * Head contract for every statically emitted job-board page.
 *
 * Keep the GPT bootstrap and Funding Choices loader together: both are
 * required by the rewarded "Candidati" flow, and emitting only one of them
 * creates a page that looks healthy while the live consent probe reports
 * `fc_not_requested`.
 */
export function jobBoardHeadTags(value: string): string {
  if (!isJobBoardPageUrl(value)) return '';
  return JOB_BOARD_HEAD_TAGS;
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
 * It starts with FC_JOBBOARD_OFFERWALL_GATE_JS. The external carrier is
 * deferred, so the parser can continue while the page is being built; once
 * executed it still installs the gate before DOMContentLoaded and before any
 * user can click the rewarded flow. The gate is idempotent: the first copy on
 * the page installs it.
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
