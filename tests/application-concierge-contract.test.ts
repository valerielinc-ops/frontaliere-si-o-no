import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  APPLICATION_CONCIERGE_CONSENT_VERSION,
  APPLICATION_CONCIERGE_CONSENT_VERSIONS,
  APPLICATION_CONCIERGE_DURATION_DAYS,
  APPLICATION_CONCIERGE_MAX_POSITIONS,
  APPLICATION_CONCIERGE_PRICE_EUR_CENTS,
  APPLICATION_CONCIERGE_PRODUCT,
  acceptedPositionsCount,
  hasApplicationConciergeConsent,
  serviceIsActive,
  serviceIsExpired,
  servicePositionLimit,
} from '../functions/src/applicationConciergeConstants.js';

describe('application concierge contract', () => {
  it('keeps the paid service bounded and non-renewing', () => {
    expect(APPLICATION_CONCIERGE_PRODUCT).toBe('application_concierge');
    expect(APPLICATION_CONCIERGE_PRICE_EUR_CENTS).toBe(3999);
    expect(APPLICATION_CONCIERGE_DURATION_DAYS).toBe(30);
    expect(APPLICATION_CONCIERGE_MAX_POSITIONS).toBe(10);
    expect(APPLICATION_CONCIERGE_CONSENT_VERSION).toBe('application-concierge-v2');
  });

  // Owner decision 2026-11-11: the consent text now says the platform accepts and sends a proposal left
  // undecided for 12 hours. New consents record v2; a v1 consent is still honoured, never asked again.
  it('records the current consent text and honours every earlier version the storage rules accept', () => {
    expect(APPLICATION_CONCIERGE_CONSENT_VERSIONS).toEqual(['application-concierge-v1', 'application-concierge-v2']);
    expect(APPLICATION_CONCIERGE_CONSENT_VERSIONS.at(-1)).toBe(APPLICATION_CONCIERGE_CONSENT_VERSION);
    const versions = `[${APPLICATION_CONCIERGE_CONSENT_VERSIONS.map((version) => `'${version}'`).join(', ')}]`;
    const storageRules = readFileSync(new URL('../storage.rules', import.meta.url), 'utf8');
    expect(storageRules).toContain(`application_concierge_services/$(serviceId)).data.consentVersion in ${versions}`);
    for (const consentVersion of APPLICATION_CONCIERGE_CONSENT_VERSIONS) {
      expect(hasApplicationConciergeConsent({ consentVersion, consentedAt: new Date(1) })).toBe(true);
      expect(hasApplicationConciergeConsent({ consentVersion, consentedAt: null })).toBe(false);
    }
    expect(hasApplicationConciergeConsent({ consentVersion: 'application-concierge-v0', consentedAt: new Date(1) })).toBe(false);
    expect(hasApplicationConciergeConsent({ consentVersion: null, consentedAt: new Date(1) })).toBe(false);
  });

  it('says in every language that an undecided proposal is accepted and sent after 12 hours', async () => {
    const expected: Record<string, RegExp> = { it: /12 ore/, en: /12 hours/, de: /12 Stunden/, fr: /12 heures/ };
    for (const [locale, twelveHours] of Object.entries(expected)) {
      const { default: translations } = await import(`../services/locales/${locale}-core.ts`);
      for (const key of ['clarityApproval', 'consent', 'step4Text', 'offerLinkHint', 'proposalsIntro']) {
        expect(translations[`jobBoard.concierge.${key}`], `${locale} ${key}`).toMatch(twelveHours);
      }
      for (const key of ['clarityApproval', 'clarityNoRenewal', 'offerLinkHint', 'step4Text', 'benefitApprovalText', 'consent', 'proposalsIntro']) {
        expect(translations[`jobBoard.concierge.${key}`], `${locale} ${key}`)
          .not.toMatch(/via libera|approvazione|go-ahead|after you approve|Einverständnis|Zustimmung|Freigabe|après votre accord|validation/i);
      }
    }
  });

  it('is active only while payment is paid and expiry is in the future', () => {
    const now = 1_700_000_000_000;
    const service = {
      paymentStatus: 'paid',
      serviceStatus: 'active',
      expiresAt: new Date(now + 1),
    };

    expect(serviceIsActive(service, now)).toBe(true);
    expect(serviceIsActive(service, now + 1)).toBe(false);
    expect(serviceIsExpired(service, now + 1)).toBe(true);
  });

  it('normalizes invalid accepted-position counters to zero', () => {
    expect(acceptedPositionsCount({ acceptedPositionsCount: 4 })).toBe(4);
    expect(acceptedPositionsCount({ acceptedPositionsCount: -1 })).toBe(0);
    expect(acceptedPositionsCount({ acceptedPositionsCount: 'not-a-number' })).toBe(0);
  });

  it('keeps stored service limits within the product-wide position cap', () => {
    expect(servicePositionLimit({ maxPositions: 7 })).toBe(7);
    expect(servicePositionLimit({ maxPositions: 10 })).toBe(10);
    expect(servicePositionLimit({ maxPositions: 20 })).toBe(10);
    expect(servicePositionLimit({ maxPositions: '20' })).toBe(10);
    expect(servicePositionLimit({})).toBe(10);
    expect(servicePositionLimit({ maxPositions: 0 })).toBe(10);
    expect(servicePositionLimit({ maxPositions: 'invalid' })).toBe(10);
    expect(servicePositionLimit({ maxPositions: -1 })).toBe(0);
    expect(servicePositionLimit({ maxPositions: 2.8 })).toBe(2);
  });
});
