import { describe, expect, it } from 'vitest';
import {
  EXPECTATION_RE,
  HELD_PERMITS,
  NATIONALITIES_AS_OF,
  PERMIT_STATUSES,
  asksHeldStatus,
  citizenshipMentions,
  euEftaNational,
  isNationalityField,
  isPermitField,
  nationalityCodes,
  nationalityCvValue,
  nationalityOf,
  permitCvValue,
  permitLabel,
  permitMentions,
  permitOmitted,
  permitOptionCode,
  permitOptions,
  permitStatement,
  permitStatusOf,
  printedPermitText,
} from '../functions/src/lib/permitStatus.js';

// The labels as shipped on 2026-10-04: answers store them, so a reworded label must keep its old text as an alias.
const SHIPPED_LABELS = {
  it: [
    'Ho la cittadinanza svizzera', 'Ho un permesso C (domicilio) valido oggi', 'Ho un permesso B (dimora) valido oggi',
    'Ho un permesso L (dimoranti temporanei) valido oggi', 'Lavoro oggi in Svizzera con un permesso G (frontalieri) valido', 'Oggi non ho un permesso svizzero',
  ],
  de: [
    'Ich habe das Schweizer Bürgerrecht', 'Ich habe eine heute gültige Niederlassungsbewilligung C', 'Ich habe eine heute gültige Aufenthaltsbewilligung B',
    'Ich habe eine heute gültige Kurzaufenthaltsbewilligung L', 'Ich arbeite heute in der Schweiz mit gültiger Grenzgängerbewilligung G', 'Ich habe heute keine Schweizer Bewilligung',
  ],
  fr: [
    'J’ai la nationalité suisse', 'J’ai une autorisation d’établissement (permis C) valable aujourd’hui', 'J’ai une autorisation de séjour (permis B) valable aujourd’hui',
    'J’ai une autorisation de courte durée (permis L) valable aujourd’hui', 'Je travaille aujourd’hui en Suisse avec un permis G (frontalier) valable', 'Je n’ai aujourd’hui aucun permis suisse',
  ],
  en: [
    'I am a Swiss citizen', 'I hold a settlement permit C, valid today', 'I hold a residence permit B, valid today',
    'I hold a short-stay permit L, valid today', 'I work in Switzerland today with a valid cross-border permit G', 'I hold no Swiss permit today',
  ],
};
const CV_WORDINGS = {
  de: ['Niederlassungsbewilligung C', 'Aufenthaltsbewilligung B', 'Kurzaufenthaltsbewilligung L', 'Grenzgängerbewilligung G'],
  fr: ["autorisation d'établissement (permis C)", 'autorisation de séjour (permis B)', 'autorisation de courte durée (permis L)', 'autorisation frontalière (permis G)'],
  it: ['permesso di domicilio (C)', 'permesso di dimora (B)', 'permesso per dimoranti temporanei (L)', 'permesso per frontalieri (G)'],
  en: ['settlement permit C', 'residence permit B', 'short-stay permit L', 'cross-border commuter permit G'],
};
const PERMITS = ['permit_c', 'permit_b', 'permit_l', 'permit_g'];

describe('permit status catalogue (owner decisions 2026-10-03)', () => {
  it('offers six statuses in a fixed order, with the labels as shipped in the candidate’s language', () => {
    expect(PERMIT_STATUSES).toEqual(['swiss', 'permit_c', 'permit_b', 'permit_l', 'permit_g', 'none']);
    expect([...HELD_PERMITS]).toEqual(PERMITS);
    for (const [locale, labels] of Object.entries(SHIPPED_LABELS)) {
      expect(permitOptions(locale)).toEqual(labels);
      // Every label reads back as its own status, the planner's sentence is the label.
      labels.forEach((label, index) => {
        expect(permitStatusOf(label)).toBe(PERMIT_STATUSES[index]);
        expect(permitStatement(PERMIT_STATUSES[index], locale)).toBe(`${label}.`);
      });
    }
    expect(permitOptions('de-CH')).toEqual(SHIPPED_LABELS.de);
    expect(permitOptions('xx')).toEqual(SHIPPED_LABELS.it);
    expect(permitStatement('', 'de')).toBe('');
    // Swiss German, never «ß».
    expect(Object.values(SHIPPED_LABELS).flat().concat(Object.values(CV_WORDINGS).flat()).filter((text) => text.includes('ß'))).toEqual([]);
  });

  it('prints a held permit by its official name in the four languages, never a bare letter nor a negative', () => {
    for (const [language, wordings] of Object.entries(CV_WORDINGS)) {
      expect(PERMITS.map((status) => permitCvValue(status, { nationality: 'italiana', language }))).toEqual(wordings);
      wordings.forEach((wording, index) => expect(permitStatusOf(wording)).toBe(PERMITS[index]));
      for (const status of ['swiss', 'none', '']) expect(permitCvValue(status, { nationality: 'italiana', language })).toBe('');
    }
  });

  it('prints the permit G only next to an EU or EFTA nationality, and says why it leaves it out', () => {
    expect(permitCvValue('permit_g', { nationality: 'italiana', language: 'de' })).toBe('Grenzgängerbewilligung G');
    expect(permitCvValue('permit_g', { nationality: 'Norwegen', language: 'fr' })).toBe('autorisation frontalière (permis G)');
    // A dual national with an EU nationality is one.
    expect(permitCvValue('permit_g', { nationality: 'italiana e albanese', language: 'it' })).toBe('permesso per frontalieri (G)');
    for (const nationality of ['albanese', 'British', '']) {
      expect(permitCvValue('permit_g', { nationality, language: 'it' })).toBe('');
      expect(permitOmitted('permit_g', nationality)).toBe(true);
    }
    expect(permitOmitted('permit_g', 'italiana')).toBe(false);
    // Only G is tied to the nationality.
    expect(permitCvValue('permit_b', { nationality: 'albanese', language: 'it' })).toBe('permesso di dimora (B)');
    expect(permitOmitted('permit_b', 'albanese')).toBe(false);
  });

  it('reads the stored values, legacy ones included, conservatively (decision 10)', () => {
    const rows: Array<[string, string]> = [
      ['G', 'permit_g'], ['B', 'permit_b'], ['C', 'permit_c'], ['L', 'permit_l'], ['permit_g', 'permit_g'],
      ['CH', 'swiss'], ['Cittadinanza svizzera', 'swiss'], ['Schweizer/in', 'swiss'], ['Swiss citizen', 'swiss'],
      ['none', 'none'], ['Non ancora', 'none'], ['nessuno', 'none'], ['keine', 'none'], ['noch nicht', 'none'], ['pas encore', 'none'], ['not yet', 'none'],
      ['Permesso G', 'permit_g'], ['Ausweis G (Grenzgänger)', 'permit_g'], ['G - Grenzgänger', 'permit_g'], ['B-Ausweis', 'permit_b'], ['Frontaliere (permesso G)', 'permit_g'],
      // A permit to come never reads as held.
      ['Permesso B in rinnovo', ''], ['Permesso G (da richiedere)', ''], ['Bewilligung G beantragt', ''], ['Permesso G scaduto', ''],
      // A status word without a permit, two permits, a driving licence, a level, a bare no.
      ['Frontaliere', ''], ['Grenzgänger', ''], ['EU/EFTA-Bürger', ''], ['Ausweis B / C', ''], ['Patente B', ''], ['permis de conduire B', ''], ['C1', ''], ['Nein', ''], ['', ''],
    ];
    for (const [value, code] of rows) expect([value, permitStatusOf(value)]).toEqual([value, code]);
    // A legacy value reads as its label in the candidate's language; an unmapped one stays as written.
    expect(permitLabel('G', 'fr')).toBe(SHIPPED_LABELS.fr[4]);
    expect(permitLabel('none', 'de')).toBe(SHIPPED_LABELS.de[5]);
    expect(permitLabel('Permesso B in rinnovo', 'it')).toBe('Permesso B in rinnovo');
    expect(permitLabel('', 'it')).toBe('');
  });

  it('prints the CV’s own words only as a fact: never a permit to come, «no permit» or an option label', () => {
    expect(printedPermitText('Permesso G da richiedere')).toBe('');
    expect(printedPermitText('nessun permesso')).toBe('');
    expect(printedPermitText(SHIPPED_LABELS.it[4])).toBe('');
    expect(printedPermitText('Permis G (frontalière)')).toBe('Permis G (frontalière)');
  });

  it('matches a portal’s option only when it says exactly one status', () => {
    const rows: Array<[string, string]> = [
      ['G (Grenzgänger)', 'permit_g'], ['Ausweis G EU/EFTA', 'permit_g'], ['Permis G (frontalier)', 'permit_g'], ['Grenzgängerbewilligung (G) – EU/EFTA', 'permit_g'],
      ['C – Settled foreign nationals', 'permit_c'], ['B (Aufenthalter)', 'permit_b'], ['C (Niedergelassene)', 'permit_c'],
      ['Schweizer/in', 'swiss'], ['Svizzera', 'swiss'], ['Keine', 'none'], ['Kein Ausweis', 'none'], ['Aucun permis', 'none'],
      ['B oder C', ''], ['B/C', ''], ['Keine (Bewilligung wird beantragt)', ''], ['Permesso G da richiedere', ''], ['Ja', ''], ['Nein', ''], ['Yes', ''],
      ['EU/EFTA', ''], ['Ich benötige eine Bewilligung', ''], ['Permis de conduire B', ''], ['Ausweis F', ''], ['Keine Angabe', ''],
    ];
    for (const [label, code] of rows) expect([label, permitOptionCode(label)]).toEqual([label, code]);
  });

  it('finds the Swiss permits a text names, never a licence, a permission or the site', () => {
    const tokens = (text: string) => permitMentions(text).map(({ code, token }) => `${code}:${token}`);
    expect(tokens('Sono titolare del permesso G e lavoro a Lugano.')).toEqual(['permit_g:permesso G']);
    expect(tokens('Ich besitze eine Grenzgängerbewilligung G.')).toEqual(['permit_g:Grenzgängerbewilligung']);
    expect(tokens('J’ai le permis B depuis 2019.')).toEqual(['permit_b:permis B']);
    expect(tokens('La Kurzaufenthaltsbewilligung L scade a marzo.')).toEqual(['permit_l:Kurzaufenthaltsbewilligung']);
    expect(tokens('I hold a valid work permit for Switzerland.')).toEqual(['generic:work permit']);
    expect(tokens('Ich habe eine Arbeitsbewilligung.')).toEqual(['generic:Arbeitsbewilligung']);
    expect(tokens('Je dispose d’un permis de travail suisse.')).toEqual(['generic:permis de travail']);
    for (const text of ['Titulaire du permis de conduire B, je suis mobile.', 'Titulaire du permis B, je me déplace chaque jour en voiture.', 'Führerausweis B vorhanden.',
      'Con il vostro permesso, allego il CV.', 'Ho la patente B.', 'Sono frontaliere da anni.', 'Visitate frontaliereticino.ch per altre offerte.']) {
      expect([text, tokens(text)]).toEqual([text, []]);
    }
  });

  it('finds a Swiss citizenship a text claims, never the adjective of a market or a firm (decision of 2026-10-04)', () => {
    const tokens = (text: string) => citizenshipMentions(text).map(({ token }) => token);
    expect(tokens('Ho la cittadinanza svizzera.')).toEqual(['cittadinanza svizzera']);
    expect(tokens('Ich habe das Schweizer Bürgerrecht.')).toEqual(['Schweizer Bürgerrecht']);
    expect(tokens('Je suis de nationalité suisse.')).toEqual(['nationalité suisse']);
    expect(tokens('I am a Swiss citizen.')).toEqual(['Swiss citizen']);
    expect(tokens('Nationalität: Schweiz')).toEqual(['Nationalität: Schweiz']);
    expect(tokens('I am Swiss.')).toEqual(['I am Swiss']);
    for (const text of ['Lavoro sul mercato svizzero.', 'A Swiss company', 'Ich bin Schweizer Meister im Schach.', 'I am Swiss-based']) expect([text, tokens(text)]).toEqual([text, []]);
  });

  it('flags every wording of a permit to come, and no catalogue string', () => {
    for (const text of ['permesso G da richiedere', 'Anspruch auf Bewilligung', 'diritto al permesso', 'Bewilligung beantragt', 'éligible au permis G', 'keine Bewilligung nötig',
      'Il permesso mi verrà rilasciato', 'Le permis sera délivré', 'Die Bewilligung wird erteilt', 'permit pending', 'I will apply for a G permit']) {
      expect([text, EXPECTATION_RE.test(text)]).toEqual([text, true]);
    }
    for (const text of ['Il permesso B richiesto dall’annuncio', 'Pur non avendo ancora il permesso G richiesto', ...Object.values(SHIPPED_LABELS).flat(), ...Object.values(CV_WORDINGS).flat()]) {
      expect([text, EXPECTATION_RE.test(text)]).toEqual([text, false]);
    }
  });
});

describe('nationality table (decision 4)', () => {
  const EU_DE = ['Österreich', 'Belgien', 'Bulgarien', 'Zypern', 'Tschechien', 'Deutschland', 'Dänemark', 'Estland', 'Spanien', 'Finnland', 'Frankreich', 'Griechenland',
    'Kroatien', 'Ungarn', 'Irland', 'Italien', 'Litauen', 'Luxemburg', 'Lettland', 'Malta', 'Niederlande', 'Polen', 'Portugal', 'Rumänien', 'Schweden', 'Slowenien', 'Slowakei'];

  it('holds the EU-27, the three EFTA states and Switzerland, not the United Kingdom, as of a date', () => {
    expect(EU_DE).toHaveLength(27);
    expect(new Set(EU_DE.map((name) => nationalityOf(name)?.code)).size).toBe(27);
    for (const name of EU_DE) expect([name, nationalityOf(name)?.group]).toEqual([name, 'eu']);
    for (const name of ['Island', 'Liechtenstein', 'Norwegen']) expect([name, nationalityOf(name)?.group]).toEqual([name, 'efta']);
    expect(nationalityOf('Schweiz')).toEqual({ code: 'CH', group: 'ch' });
    for (const name of ['Vereinigtes Königreich', 'United Kingdom', 'UK', 'britannica', 'British']) expect([name, nationalityOf(name)]).toEqual([name, null]);
    expect(NATIONALITIES_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('reads one nationality in any language and prints it in the CV’s, with the tag derived in code', () => {
    for (const text of ['italiana', 'Italiana (UE)', 'cittadinanza italiana', 'Italien', 'Italian citizen', 'italienische Staatsangehörigkeit']) {
      expect([text, ['de', 'fr', 'it', 'en'].map((language) => nationalityCvValue(text, { language }))]).toEqual([text, ['Italien (EU)', 'italienne (UE)', 'italiana (UE)', 'Italian (EU)']]);
    }
    expect(['de', 'fr', 'it', 'en'].map((language) => nationalityCvValue('Norwegen', { language }))).toEqual(['Norwegen (EFTA)', 'norvégienne (AELE)', 'norvegese (AELS)', 'Norwegian (EFTA)']);
    expect(['de', 'fr', 'it', 'en'].map((language) => nationalityCvValue('Svizzera', { language }))).toEqual(['Schweiz', 'suisse', 'svizzera', 'Swiss']);
    // The forms of the federal list of state names (EDA, 21.08.2026): «hellénique», «ellenica», «neerlandese»;
    // no Italian adjective for Liechtenstein, so its short form.
    expect(nationalityCvValue('griechisch', { language: 'fr' })).toBe('hellénique (UE)');
    expect(nationalityCvValue('Grecia', { language: 'it' })).toBe('ellenica (UE)');
    expect(nationalityCvValue('olandese', { language: 'it' })).toBe('neerlandese (UE)');
    expect(nationalityCvValue('Liechtensteinerin', { language: 'it' })).toBe('Liechtenstein (AELS)');
    // Anything else as the candidate wrote it, no tag.
    for (const text of ['Schweiz / Kroatien', 'britannica', 'albanese']) expect(nationalityCvValue(text, { language: 'de' })).toBe(text);
    expect(nationalityCvValue('', { language: 'de' })).toBe('');
  });

  it('prints Swiss for the status «swiss», first beside another nationality (decision of 2026-10-04 on dual nationals)', () => {
    expect(['de', 'fr', 'it', 'en'].map((language) => nationalityCvValue('', { status: 'swiss', language }))).toEqual(['Schweiz', 'suisse', 'svizzera', 'Swiss']);
    expect(['de', 'fr', 'it', 'en'].map((language) => nationalityCvValue('italiana', { status: 'swiss', language })))
      .toEqual(['Schweiz und Italien (EU)', 'suisse et italienne (UE)', 'svizzera e italiana (UE)', 'Swiss and Italian (EU)']);
    // Already said: as written; another status leaves the line alone.
    expect(nationalityCvValue('Schweiz / Kroatien', { status: 'swiss', language: 'de' })).toBe('Schweiz / Kroatien');
    expect(nationalityCvValue('Svizzera', { status: 'swiss', language: 'it' })).toBe('svizzera');
    expect(nationalityCvValue('italiana', { status: 'permit_b', language: 'it' })).toBe('italiana (UE)');
  });

  it('reads the nationalities of a dual national, and whether one of them is EU or EFTA', () => {
    expect([...nationalityCodes('Schweiz / Kroatien')].sort()).toEqual(['CH', 'HR']);
    expect([...nationalityCodes('italiana e albanese')]).toEqual(['IT']);
    expect(euEftaNational('italiana e albanese')).toBe(true);
    expect(euEftaNational('Svizzera')).toBe(false);
    expect(euEftaNational('albanese')).toBe(false);
  });
});

describe('form-field wordings (one source for the portal guard and the questions)', () => {
  it('reads permit and work-authorisation fields in four languages, never a licence', () => {
    for (const label of ['Arbeitserlaubnis', 'Are you legally authorised to work in Switzerland?', 'Do you have the right to work in Switzerland?', 'Will you require sponsorship?',
      'Avez-vous un permis de travail valable en Suisse ?', 'Autorisation de travail', 'Aufenthaltsstatus', 'Titre de séjour', 'Statut de séjour', 'Work authorization status',
      'Visa status', 'Ausweistyp', 'Qual è il suo stato di autorizzazione al lavoro per Svizzera?', 'Work permit *']) {
      expect([label, isPermitField(label)]).toEqual([label, true]);
    }
    for (const label of ['Permis de conduire', 'Führerausweis', 'Fahrausweis Kategorie B', 'Berufsausübungsbewilligung', 'Country', 'Aufenthaltsort', 'Land', 'Wohnort', 'Privacy', 'Patente di guida', 'Ausweis-Nr.']) {
      expect([label, isPermitField(label)]).toEqual([label, false]);
    }
  });

  it('reads nationality and citizenship fields, and tells a field that asks a need from one that asks the status held', () => {
    for (const label of ['Nazionalità', 'Cittadinanza', 'Staatsangehörigkeit', 'Citizenship', 'Nationalité']) expect([label, isNationalityField(label)]).toEqual([label, true]);
    for (const label of ['Country', 'Arbeitserlaubnis']) expect([label, isNationalityField(label)]).toEqual([label, false]);
    expect(asksHeldStatus('Welche Bewilligung benötigen Sie?')).toBe(false);
    expect(asksHeldStatus('Will you require sponsorship?')).toBe(false);
    expect(asksHeldStatus('Welche Bewilligung haben Sie?')).toBe(true);
  });
});
