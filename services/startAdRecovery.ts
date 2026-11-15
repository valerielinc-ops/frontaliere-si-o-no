import { ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_CHANGE_EVENT } from './adsConsent';
import { AD_CLIENT } from './adsenseSlots';
import { installAdRecovery } from './adRecovery';
import { probeIabAdBlock } from './iabAdBlockProbe';
import { createAdScriptLoader } from './adScriptLoader';
import { emitAdDiagnostic } from './adDiagnostics';
import { isLikelyBot } from './botPatterns';
import { hasActiveReaderNoAdsEntitlement, onReaderEntitlementChange } from './readerEntitlement';
import { sanitizeTelemetryProperties } from './analyticsUrlPrivacy.js';
import { isSensitiveThirdPartyDocument } from './thirdPartyDocumentPrivacy.js';
import { wasNewsletterAutologinAttempted } from './newsletterAutologinSignal';
import { createHouseAdCreative, HOUSE_AD_CREATIVE_CSS, HOUSE_AD_VARIANTS } from './houseAdCreative';
import { installHouseAds } from './houseAdRuntime';
import { READER_SUBSCRIPTION_PATHS } from './readerSubscriptionPath';

let entitlementSubscribed = false;

export function startAdRecovery() {
  if (typeof window === 'undefined' || window.location.hostname !== 'frontaliereticino.ch' || isLikelyBot()) return;
  const allowed = () => !hasActiveReaderNoAdsEntitlement() && !isSensitiveThirdPartyDocument(sanitizeTelemetryProperties, window, document, wasNewsletterAutologinAttempted());
  const houseAds = installHouseAds(createHouseAdCreative, HOUSE_AD_CREATIVE_CSS, emitAdDiagnostic, allowed, {
    assignmentUrl: 'https://europe-west6-frontaliere-ticino.cloudfunctions.net/getHouseAdCreativeAssignment',
    consentKey: ADS_CONSENT_STORAGE_KEY, consentEvent: ADS_CONSENT_CHANGE_EVENT, variants: HOUSE_AD_VARIANTS,
    readerSubscriptionPaths: READER_SUBSCRIPTION_PATHS,
  });
  const recovery = installAdRecovery(probeIabAdBlock, createAdScriptLoader, emitAdDiagnostic, allowed,
    { consentKey: ADS_CONSENT_STORAGE_KEY, consentEvent: ADS_CONSENT_CHANGE_EVENT, publisherId: AD_CLIENT.replace(/^ca-/, ''), inlineHouseAds: true, readerSubscriptionPaths: Object.values(READER_SUBSCRIPTION_PATHS) });
  if (!entitlementSubscribed) {
    entitlementSubscribed = true;
    onReaderEntitlementChange(() => { houseAds?.refresh(); recovery.refresh(); });
  }
  return recovery;
}
