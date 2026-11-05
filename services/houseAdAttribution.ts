import { sanitizeHouseAdAttribution } from '@/functions/src/houseAdAttribution.js';
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
    component: `${a.experimentId}.${a.creativeId}.${a.enrolled ? 'test' : 'fixed'}.${a.locale}`,
    format: a.format, locale: a.locale, placement: a.placement,
    surface: `${a.format}.${a.placement}`, device: a.device,
  });
}
