/**
 * The Swiss statuses a candidate chooses from and their labels, in the four
 * languages. Split from permitStatus.js so the browser (the CV upload form,
 * components/community/AssistedApplicationCandidateFacts.tsx) can show the
 * same list without bundling that module's regular expressions, whose
 * lookbehinds older Safari/WebKit cannot parse (scripts/ci/check-client-lookbehind.mjs).
 *
 * Pure JavaScript, no import, no lookbehind.
 */

// Select order of the six statuses.
export const PERMIT_STATUSES = ['swiss', 'permit_c', 'permit_b', 'permit_l', 'permit_g', 'none'];

// The options the candidate chooses from, stored as chosen (the visible label). A held permit is one
// valid today; G names the job it depends on (whether a card is still valid after the job ended differs
// by canton). Nothing about what a permit allows.
export const PERMIT_LABELS = {
  it: {
    swiss: 'Ho la cittadinanza svizzera',
    permit_c: 'Ho un permesso C (domicilio) valido oggi',
    permit_b: 'Ho un permesso B (dimora) valido oggi',
    permit_l: 'Ho un permesso L (dimoranti temporanei) valido oggi',
    permit_g: 'Lavoro oggi in Svizzera con un permesso G (frontalieri) valido',
    none: 'Oggi non ho un permesso svizzero',
  },
  de: {
    swiss: 'Ich habe das Schweizer Bürgerrecht',
    permit_c: 'Ich habe eine heute gültige Niederlassungsbewilligung C',
    permit_b: 'Ich habe eine heute gültige Aufenthaltsbewilligung B',
    permit_l: 'Ich habe eine heute gültige Kurzaufenthaltsbewilligung L',
    permit_g: 'Ich arbeite heute in der Schweiz mit gültiger Grenzgängerbewilligung G',
    none: 'Ich habe heute keine Schweizer Bewilligung',
  },
  fr: {
    swiss: 'J’ai la nationalité suisse',
    permit_c: 'J’ai une autorisation d’établissement (permis C) valable aujourd’hui',
    permit_b: 'J’ai une autorisation de séjour (permis B) valable aujourd’hui',
    permit_l: 'J’ai une autorisation de courte durée (permis L) valable aujourd’hui',
    permit_g: 'Je travaille aujourd’hui en Suisse avec un permis G (frontalier) valable',
    none: 'Je n’ai aujourd’hui aucun permis suisse',
  },
  en: {
    swiss: 'I am a Swiss citizen',
    permit_c: 'I hold a settlement permit C, valid today',
    permit_b: 'I hold a residence permit B, valid today',
    permit_l: 'I hold a short-stay permit L, valid today',
    permit_g: 'I work in Switzerland today with a valid cross-border permit G',
    none: 'I hold no Swiss permit today',
  },
};

/** "de-CH" reads "de"; an unknown language reads Italian. */
export const permitLabelLanguage = (locale) => {
  const code = String(locale || '').slice(0, 2).toLowerCase();
  return PERMIT_LABELS[code] ? code : 'it';
};

/** The six options in the candidate's language, in select order. */
export function permitOptions(locale) {
  const labels = PERMIT_LABELS[permitLabelLanguage(locale)];
  return PERMIT_STATUSES.map((code) => labels[code]);
}
