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
  const marker = `${a.clickedAt}:${a.creativeId}`;
  try {
    if (sessionStorage.getItem('ft_house_ad_landing_v1') === marker) return;
    sessionStorage.setItem('ft_house_ad_landing_v1', marker);
  } catch { return; }
  emitAdDiagnostic('house_ad_landing', { action: 'landing', component: `${a.creativeId}.${a.enrolled ? 'test' : 'fixed'}.${a.locale}`, surface: `${a.format}.${a.placement}` });
}
