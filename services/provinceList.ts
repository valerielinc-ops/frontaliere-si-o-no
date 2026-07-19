/**
 * Italian province code → display name.
 *
 * Extracted from a local `PROVINCE_NAMES` const previously duplicated in
 * `components/guide/FrontierGuide.tsx` — now also used by
 * `components/guide/TrafficAlerts.tsx`'s crossing filter, so it lives here
 * as the single shared copy (AGENTS.md rule on duplicated constants: a
 * literal map needed in ≥2 files must live in one shared module).
 *
 * NOT a canton lookup — provinces are Italian administrative units (the
 * foreign side of a crossing/municipality), cantons are Swiss. See
 * `build-plugins/shared/cantonDisplay.ts` for the canton equivalent. Unlike
 * canton names, Italian province names are proper nouns and are not
 * translated per locale (same spelling in it/en/de/fr), so there is no
 * locale parameter here.
 *
 * Covers every province currently feeding the Ticino/Vallese border
 * corridor. A future non-Italian crossing (France/Germany/Austria/
 * Liechtenstein) won't have a matching entry — `getProvinceName()` falls
 * back to the raw code in that case rather than throwing or showing
 * "undefined".
 */
export const PROVINCE_NAMES: Record<string, string> = {
  CO: 'Como', VA: 'Varese', VB: 'Verbania', SO: 'Sondrio', LC: 'Lecco',
  AO: 'Aosta', VC: 'Vercelli', MB: 'Monza-Brianza', BG: 'Bergamo',
  BS: 'Brescia', TN: 'Trento', BZ: 'Bolzano',
};

/** Province display name, falling back to the raw code if unknown. */
export function getProvinceName(code: string): string {
  return PROVINCE_NAMES[code] ?? code;
}
