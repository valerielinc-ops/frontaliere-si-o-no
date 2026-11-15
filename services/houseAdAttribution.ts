import { sanitizeHouseAdAttribution, sanitizeReaderSubscriptionAdAttribution } from '@/functions/src/houseAdAttribution.js';
import { emitAdDiagnostic } from './adDiagnostics';

/** Same-origin session survives sign-in and is copied only into a NEW order. */
export function getHouseAdAttribution() {
  try {
    if (JSON.parse(localStorage.getItem('frontaliere_consent') || '{}').analytics === false) return null;
    return sanitizeHouseAdAttribution(JSON.parse(sessionStorage.getItem('ft_house_ad_click_v1') || 'null'));
  }
  catch { return null; }
}

export function trackHouseAdLanding() {
  const a = getHouseAdAttribution();
  if (!a) return;
  const marker = `${a.clickedAt}:${a.experimentId}:${a.creativeId}`;
  try {
    if (sessionStorage.getItem('ft_house_ad_landing_v1') === marker) return;
    sessionStorage.setItem('ft_house_ad_landing_v1', marker);
  } catch { return; }
  emitAdDiagnostic('house_ad_landing', {
    action: 'landing', campaign: a.campaign, experiment_id: a.experimentId,
    experiment_variant: a.variant, assignment_source: a.assignmentSource,
    enrolled: Number(a.enrolled), creative_id: a.creativeId,
    component: `${a.experimentId}.${a.creativeId}.${a.enrolled ? 'test' : 'fixed'}.${a.locale}.${a.contextSource}.${a.contextSector}`,
    format: a.format, locale: a.locale, placement: a.placement,
    surface: `${a.format}.${a.placement}`, device: a.device,
  });
}

/** Cohort touchpoint survives the same-tab route to checkout; never includes a browser ID. */
export function getReaderSubscriptionAdAttribution() {
  try {
    if (JSON.parse(localStorage.getItem('frontaliere_consent') || '{}').analytics === false) return null;
    const click = sessionStorage.getItem('ft_reader_subscription_ad_click_v1');
    const exposure = sessionStorage.getItem('ft_reader_subscription_attribution_v1');
    const clickAttribution = sanitizeReaderSubscriptionAdAttribution(JSON.parse(click || 'null'));
    return clickAttribution || sanitizeReaderSubscriptionAdAttribution(JSON.parse(exposure || 'null'));
  } catch { return null; }
}

export function trackReaderSubscriptionAdLanding() {
  let value: unknown;
  try {
    if (JSON.parse(localStorage.getItem('frontaliere_consent') || '{}').analytics === false) return;
    value = JSON.parse(sessionStorage.getItem('ft_reader_subscription_ad_click_v1') || 'null');
  } catch { return; }
  const a = sanitizeReaderSubscriptionAdAttribution(value);
  if (!a || a.touchpoint !== 'click') return;
  const marker = `${a.attributedAt}:${a.experimentId}:${a.creativeId}`;
  try {
    if (sessionStorage.getItem('ft_reader_subscription_ad_landing_v1') === marker) return;
    sessionStorage.setItem('ft_reader_subscription_ad_landing_v1', marker);
  } catch { return; }
  emitAdDiagnostic('reader_subscription_ad_landing', {
    action: 'landing', campaign: a.campaign, experiment_id: a.experimentId,
    experiment_variant: a.variant, assignment_source: a.assignmentSource,
    enrolled: Number(a.enrolled), creative_id: a.creativeId,
    component: `${a.experimentId}.${a.variant}.test.${a.locale}`,
    format: a.format, locale: a.locale, placement: a.placement,
    surface: `${a.format}.${a.placement}`, device: a.device,
  });
}
