import { ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_CHANGE_EVENT } from './adsConsent';
import { AD_CLIENT } from './adsenseSlots';
import { installAdRecovery } from './adRecovery';
import { probeIabAdBlock } from './iabAdBlockProbe';
import { createAdScriptLoader } from './adScriptLoader';
import { emitAdDiagnostic } from './adDiagnostics';
import { isLikelyBot } from './botPatterns';
import { hasActiveReaderNoAdsEntitlement } from './readerEntitlement';
import { sanitizeTelemetryProperties } from './analyticsUrlPrivacy.js';
import { isSensitiveThirdPartyDocument } from './thirdPartyDocumentPrivacy.js';
import { wasNewsletterAutologinAttempted } from './newsletterAutologinSignal';

export function startAdRecovery() {
  if (typeof window === 'undefined' || window.location.hostname !== 'frontaliereticino.ch' || isLikelyBot()) return;
  return installAdRecovery(probeIabAdBlock, createAdScriptLoader, emitAdDiagnostic, () =>
    !hasActiveReaderNoAdsEntitlement() && !isSensitiveThirdPartyDocument(sanitizeTelemetryProperties, window, document, wasNewsletterAutologinAttempted()),
    { consentKey: ADS_CONSENT_STORAGE_KEY, consentEvent: ADS_CONSENT_CHANGE_EVENT, publisherId: AD_CLIENT.replace(/^ca-/, '') });
}
