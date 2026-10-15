import { describe, expect, it } from 'vitest';
import {
  WELCOME_SEGMENTS,
  SECTOR_KEYS,
  TOOL_KEYS,
  safeFirstName,
  sanitizeCompany,
  sanitizeLocation,
  normalizeSector,
  resolveJobBackPath,
  resolveWelcomeContext,
} from '../functions/src/lib/welcomeSegment.js';

describe('exported shape constants', () => {
  it('WELCOME_SEGMENTS has the 5 segments', () => {
    expect(WELCOME_SEGMENTS).toEqual(['job', 'salary', 'utility', 'publisher', 'general']);
  });

  it('SECTOR_KEYS covers the 13 sector buckets', () => {
    expect(SECTOR_KEYS).toEqual([
      'health', 'admin', 'retail', 'hospitality', 'logistics', 'finance',
      'tech', 'industry', 'education', 'construction', 'transport', 'cleaning', 'other',
    ]);
  });

  it('TOOL_KEYS has the 6 tool identifiers', () => {
    expect(TOOL_KEYS).toEqual(['lamal', 'wizard', 'leadmagnet', 'selfcert', 'calculator', 'comparator']);
  });
});

describe('sanitizeCompany — real corrupted production values are rejected', () => {
  it('rejects prose fragment starting with ")"', () => {
    expect(sanitizeCompany('). Vorab erhältst du einen Überblick über Ablauf und Lernziele – so weißt du immer, was dich erwartet und was du für deine berufliche Zukunf')).toBeNull();
  });

  it('rejects prose fragment starting with ","', () => {
    expect(sanitizeCompany(', Planung und Durchführung von Communities, Trainings und Workshops hilfst du aktiv mit Du übernimmst ad-hoc Aufgaben im Team, um flexibel u')).toBeNull();
  });
});

describe('sanitizeCompany — real good production values survive unchanged', () => {
  it.each([
    'EOC – Ente Ospedaliero Cantonale',
    'LIS – Lugano Istituti Sociali',
    'Città di Mendrisio',
    'A++ Group',
    'SUPSI / DTI',
    'Bell Schweiz AG',
    'IKEA',
    "McDonald's Switzerland",
    'Ferrovia Retica (RhB)',
    'Casale SA',
    'Amministrazione Cantonale Ticino',
    'ALDI SUISSE',
    'Cornèr Banca',
    'Città di Lugano',
  ])('accepts %s unchanged', (value) => {
    expect(sanitizeCompany(value)).toBe(value);
  });
});

describe('sanitizeCompany — prose bypass regression (adversarial review)', () => {
  // Confirmed live: these ordinary marketing sentences were returned
  // UNCHANGED by the pre-fix validators — the old >7-word rule alone never
  // caught them ("Unisciti al nostro team dinamico" is only 5 words), and
  // none of them trip the punctuation/connector-word guards, which only
  // fire on truncated-prose shapes, not clean marketing copy. The fix adds
  // a prose-token count (lowercase, non-connector words) and a
  // marketing-verb stoplist as two independent nets.
  it('rejects "Scopri subito tutte le nostre posizioni aperte" (IT marketing sentence)', () => {
    expect(sanitizeCompany('Scopri subito tutte le nostre posizioni aperte')).toBeNull();
  });

  it('rejects "Jetzt bewerben bei uns heute noch" (DE marketing sentence)', () => {
    expect(sanitizeCompany('Jetzt bewerben bei uns heute noch')).toBeNull();
  });

  it('rejects "Unisciti al nostro team dinamico" (IT marketing sentence, only 5 words)', () => {
    expect(sanitizeCompany('Unisciti al nostro team dinamico')).toBeNull();
  });

  // Confirmed live: sanitizeCompany('Acme Corp‮gnp.exe') returned unchanged
  // pre-fix. Contains U+202E RIGHT-TO-LEFT OVERRIDE — a text-spoofing vector
  // (e.g. making a trailing ".exe" render reversed) once rendered into HTML.
  it('rejects a value containing a bidi-override character (RTLO text-spoofing)', () => {
    expect(sanitizeCompany('Acme Corp‮gnp.exe')).toBeNull();
  });
});

describe('sanitizeCompany — structural guards', () => {
  it('rejects non-string / empty / whitespace-only', () => {
    expect(sanitizeCompany(undefined)).toBeNull();
    expect(sanitizeCompany(null)).toBeNull();
    expect(sanitizeCompany(42)).toBeNull();
    expect(sanitizeCompany('')).toBeNull();
    expect(sanitizeCompany('   ')).toBeNull();
  });

  it('rejects values over 60 chars or under 2 chars', () => {
    expect(sanitizeCompany('A')).toBeNull();
    expect(sanitizeCompany('X'.repeat(61))).toBeNull();
  });

  it('rejects HTML/markup injection hazards', () => {
    expect(sanitizeCompany('<script>alert(1)</script>')).toBeNull();
    expect(sanitizeCompany('Acme <b>Corp</b>')).toBeNull();
  });

  it('rejects a bare URL or email address masquerading as a company', () => {
    expect(sanitizeCompany('https://evil.example.com')).toBeNull();
    expect(sanitizeCompany('contact@evil.example.com')).toBeNull();
  });

  it('rejects sentences smuggled past the punctuation check via connector words', () => {
    expect(sanitizeCompany('Team Marketing and Sales')).toBeNull();
    expect(sanitizeCompany('Kundenservice und Support')).toBeNull();
  });

  it('rejects more than 7 words', () => {
    expect(sanitizeCompany('One Two Three Four Five Six Seven Eight')).toBeNull();
  });
});

describe('sanitizeLocation — canton codes and casing', () => {
  it('maps every known 2-letter canton code case-insensitively', () => {
    expect(sanitizeLocation('ti')).toBe('Ticino');
    expect(sanitizeLocation('TI')).toBe('Ticino');
    expect(sanitizeLocation('vd')).toBe('Vaud');
    expect(sanitizeLocation('gr')).toBe('Grigioni');
    expect(sanitizeLocation('vs')).toBe('Vallese');
    expect(sanitizeLocation('zh')).toBe('Zurigo');
    expect(sanitizeLocation('be')).toBe('Berna');
    expect(sanitizeLocation('ge')).toBe('Ginevra');
    expect(sanitizeLocation('bs')).toBe('Basilea');
    expect(sanitizeLocation('lu')).toBe('Lucerna');
    expect(sanitizeLocation('sg')).toBe('San Gallo');
    expect(sanitizeLocation('ag')).toBe('Argovia');
    expect(sanitizeLocation('so')).toBe('Soletta');
    expect(sanitizeLocation('ne')).toBe('Neuchâtel');
    expect(sanitizeLocation('fr')).toBe('Friborgo');
    expect(sanitizeLocation('ju')).toBe('Giura');
    expect(sanitizeLocation('sh')).toBe('Sciaffusa');
    expect(sanitizeLocation('tg')).toBe('Turgovia');
    expect(sanitizeLocation('zg')).toBe('Zugo');
    expect(sanitizeLocation('sz')).toBe('Svitto');
    expect(sanitizeLocation('ur')).toBe('Uri');
    expect(sanitizeLocation('ow')).toBe('Obvaldo');
    expect(sanitizeLocation('nw')).toBe('Nidvaldo');
    expect(sanitizeLocation('gl')).toBe('Glarona');
    expect(sanitizeLocation('ar')).toBe('Appenzello Esterno');
    expect(sanitizeLocation('ai')).toBe('Appenzello Interno');
  });

  it('capitalizes an all-lowercase single word', () => {
    expect(sanitizeLocation('lugano')).toBe('Lugano');
  });

  it('leaves already-capitalized real values unchanged', () => {
    expect(sanitizeLocation('Lugano')).toBe('Lugano');
    expect(sanitizeLocation('Bellinzona')).toBe('Bellinzona');
    expect(sanitizeLocation('Mendrisio')).toBe('Mendrisio');
    expect(sanitizeLocation('Basel')).toBe('Basel');
    expect(sanitizeLocation('Pregassona')).toBe('Pregassona');
    expect(sanitizeLocation('Locarno')).toBe('Locarno');
    expect(sanitizeLocation('Ticino')).toBe('Ticino');
    expect(sanitizeLocation('Chur')).toBe('Chur');
    expect(sanitizeLocation('Zürich')).toBe('Zürich');
    expect(sanitizeLocation('Bern')).toBe('Bern');
    expect(sanitizeLocation('Genève')).toBe('Genève');
    expect(sanitizeLocation('St. Moritz')).toBe('St. Moritz');
    expect(sanitizeLocation('Oensingen')).toBe('Oensingen');
    expect(sanitizeLocation('La Chaux-de-Fonds')).toBe('La Chaux-de-Fonds');
  });

  it('rejects the corrupted prose fragment "en in elf Ländern weltweit. Seit dem"', () => {
    expect(sanitizeLocation('en in elf Ländern weltweit. Seit dem')).toBeNull();
  });

  it('rejects non-string / empty / oversized / markup values', () => {
    expect(sanitizeLocation(undefined)).toBeNull();
    expect(sanitizeLocation(null)).toBeNull();
    expect(sanitizeLocation({})).toBeNull();
    expect(sanitizeLocation('')).toBeNull();
    expect(sanitizeLocation('X'.repeat(41))).toBeNull();
    expect(sanitizeLocation('<script>x</script>')).toBeNull();
  });
});

describe('sanitizeLocation — prose bypass regression (adversarial review)', () => {
  // Confirmed live: sanitizeLocation('Grosse Nachfrage aktuell') returned
  // unchanged pre-fix — 3 words, under the old >4-word bar, and none of the
  // German nouns (capitalized, as German nouns always are) trip the
  // lowercase-prose punctuation/connector checks. "aktuell" is the only
  // genuinely lowercase, non-connector token — one is enough to reject a
  // location (stricter than the company 2-token bar), and it's also on the
  // marketing stoplist as a second, independent net.
  it('rejects "Grosse Nachfrage aktuell" (DE marketing sentence)', () => {
    expect(sanitizeLocation('Grosse Nachfrage aktuell')).toBeNull();
  });
});

describe('normalizeSector — all 16 real production values map correctly', () => {
  it.each([
    ['admin', 'admin'],
    ['tech', 'tech'],
    ['finance', 'finance'],
    ['other', 'other'],
    ['Sanita / Ospedali', 'health'],
    ['Sanità / Ospedali', 'health'],
    ['Ospedaliero/Medicale/Sanitario/Educativo', 'health'],
    ['Vendita / Retail', 'retail'],
    ['Ristorazione / Hotel', 'hospitality'],
    ['Trasporti / Logistica', 'logistics'],
    ['Amministrazione', 'admin'],
    ['Produzione / Tecnica', 'industry'],
    ['Altro', 'other'],
    ['Finanza / Banca', 'finance'],
    ['Logistica', 'logistics'],
    ['IT / Tecnologia', 'tech'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeSector(raw)).toBe(expected);
    expect(SECTOR_KEYS).toContain(expected);
  });

  it('returns null (not "other") for an unrecognized sector label', () => {
    expect(normalizeSector('Marketing')).toBeNull();
    expect(normalizeSector('Legal')).toBeNull();
  });

  it('returns null for non-string / empty / prose-like values', () => {
    expect(normalizeSector(undefined)).toBeNull();
    expect(normalizeSector(null)).toBeNull();
    expect(normalizeSector([])).toBeNull();
    expect(normalizeSector('')).toBeNull();
  });
});

describe('safeFirstName', () => {
  it('rejects "Tenuta Ferraro srl" (company, not a person)', () => {
    expect(safeFirstName({ name: 'Tenuta Ferraro srl' })).toBeNull();
    expect(safeFirstName({ firstName: 'Tenuta', name: 'Tenuta Ferraro srl' })).toBeNull();
  });

  it('rejects other company-suffixed names', () => {
    expect(safeFirstName({ name: 'Rossi & Figli' })).toBeNull();
    expect(safeFirstName({ name: 'Bianchi e Figli' })).toBeNull();
    expect(safeFirstName({ name: 'Acme S.p.A.' })).toBeNull();
    expect(safeFirstName({ name: 'Muster GmbH' })).toBeNull();
  });

  it('rejects "A" (too short)', () => {
    expect(safeFirstName({ firstName: 'A' })).toBeNull();
  });

  it('rejects "P.F." (contains a period)', () => {
    expect(safeFirstName({ firstName: 'P.F.' })).toBeNull();
  });

  it('rejects "AR" (all-caps initials shape)', () => {
    expect(safeFirstName({ firstName: 'AR' })).toBeNull();
  });

  it('rejects digits, whitespace, and other forbidden characters', () => {
    expect(safeFirstName({ firstName: 'Mario1' })).toBeNull();
    expect(safeFirstName({ firstName: 'Mario Rossi' })).toBeNull();
    expect(safeFirstName({ firstName: 'user@example.com' })).toBeNull();
    expect(safeFirstName({ firstName: '<script>' })).toBeNull();
  });

  it('accepts "Diana"', () => {
    expect(safeFirstName({ firstName: 'Diana' })).toBe('Diana');
  });

  it('accepts "Luca"', () => {
    expect(safeFirstName({ firstName: 'Luca' })).toBe('Luca');
  });

  it('accepts "Jean-Luc" unchanged (internal capital after hyphen)', () => {
    expect(safeFirstName({ firstName: 'Jean-Luc' })).toBe('Jean-Luc');
  });

  it('accepts "D\'Angelo" unchanged (internal capital after apostrophe)', () => {
    expect(safeFirstName({ firstName: "D'Angelo" })).toBe("D'Angelo");
  });

  it('derives from the first token of doc.name when firstName is absent', () => {
    expect(safeFirstName({ name: 'Mario Rossi' })).toBe('Mario');
  });

  it('capitalizes an all-lowercase firstName', () => {
    expect(safeFirstName({ firstName: 'diana' })).toBe('Diana');
  });

  it('returns null for a doc with no usable name field', () => {
    expect(safeFirstName({})).toBeNull();
    expect(safeFirstName(null)).toBeNull();
    expect(safeFirstName(undefined)).toBeNull();
  });
});

describe('resolveJobBackPath', () => {
  it('returns real localized job paths with a trailing slash', () => {
    expect(resolveJobBackPath({ source_page: '/cerca-lavoro-ticino/receptionist-100-a-group-5250/' }))
      .toBe('/cerca-lavoro-ticino/receptionist-100-a-group-5250/');
    expect(resolveJobBackPath({ source_page: '/de/jobs-im-tessin/rezeptionist-100-a-group-5250' }))
      .toBe('/de/jobs-im-tessin/rezeptionist-100-a-group-5250/');
    expect(resolveJobBackPath({ source_page: '/fr/trouver-emploi-tessin/receptionniste-100-a-group-5250' }))
      .toBe('/fr/trouver-emploi-tessin/receptionniste-100-a-group-5250/');
  });

  it('returns null for "/"', () => {
    expect(resolveJobBackPath({ source_page: '/' })).toBeNull();
  });

  it('returns null for query-string or fragment paths', () => {
    expect(resolveJobBackPath({ source_page: '/cerca-lavoro-ticino/foo?ref=email' })).toBeNull();
    expect(resolveJobBackPath({ source_page: '/cerca-lavoro-ticino/foo#top' })).toBeNull();
    expect(resolveJobBackPath({ source_page: 'https://frontaliereticino.ch/cerca-lavoro-ticino/foo' })).toBeNull();
  });

  it('returns null for a single-segment path', () => {
    expect(resolveJobBackPath({ source_page: '/cerca-lavoro-ticino' })).toBeNull();
  });

  it('never synthesizes a path from job_slug', () => {
    expect(resolveJobBackPath({ job_slug: 'receptionist-100-a-group-5250' })).toBeNull();
  });

  it('returns null for a missing or non-string source_page', () => {
    expect(resolveJobBackPath({})).toBeNull();
    expect(resolveJobBackPath({ source_page: 42 })).toBeNull();
  });
});

describe('resolveWelcomeContext — segment routing (one case per segment)', () => {
  it('routes to "publisher" via source_cta prefix', () => {
    const ctx = resolveWelcomeContext({ source_cta: 'publisher_gate_unlock' });
    expect(ctx.segment).toBe('publisher');
  });

  it('routes to "publisher" via source_route_family', () => {
    const ctx = resolveWelcomeContext({ source_route_family: 'publisher' });
    expect(ctx.segment).toBe('publisher');
  });

  it('routes to "job" via a surviving personalization slot', () => {
    const ctx = resolveWelcomeContext({
      job_company: 'IKEA',
      source_page: '/cerca-lavoro-ticino/receptionist-100-a-group-5250/',
    });
    expect(ctx.segment).toBe('job');
    expect(ctx.company).toBe('IKEA');
    expect(ctx.jobBackPath).toBe('/cerca-lavoro-ticino/receptionist-100-a-group-5250/');
  });

  it('routes to "job" via an explicit job source_cta even with no clean slots', () => {
    const ctx = resolveWelcomeContext({ source_cta: 'job_board_email_unlock' });
    expect(ctx.segment).toBe('job');
  });

  it('routes to "job" via source starting with "job_"', () => {
    const ctx = resolveWelcomeContext({ source: 'job_alert_email' });
    expect(ctx.segment).toBe('job');
  });

  it('routes to "salary" via post_calc_cta', () => {
    const ctx = resolveWelcomeContext({ source: 'post_calc_cta' });
    expect(ctx.segment).toBe('salary');
    expect(ctx.toolKey).toBe('calculator');
  });

  it('routes to "salary" via source_route_family calculator', () => {
    const ctx = resolveWelcomeContext({ source_route_family: 'calculator' });
    expect(ctx.segment).toBe('salary');
    expect(ctx.toolKey).toBe('calculator');
  });

  it('routes to "utility" via lamal_ssn_tool', () => {
    const ctx = resolveWelcomeContext({ source: 'lamal_ssn_tool' });
    expect(ctx.segment).toBe('utility');
    expect(ctx.toolKey).toBe('lamal');
  });

  it('routes to "utility" via frontaliere_wizard', () => {
    const ctx = resolveWelcomeContext({ source: 'frontaliere_wizard' });
    expect(ctx.segment).toBe('utility');
    expect(ctx.toolKey).toBe('wizard');
  });

  it('routes to "utility" via self_cert* source', () => {
    const ctx = resolveWelcomeContext({ source: 'self_cert_start' });
    expect(ctx.segment).toBe('utility');
    expect(ctx.toolKey).toBe('selfcert');
  });

  it('routes to "utility" via lead_magnet* source', () => {
    const ctx = resolveWelcomeContext({ source: 'lead_magnet_guide' });
    expect(ctx.segment).toBe('utility');
    expect(ctx.toolKey).toBe('leadmagnet');
  });

  it('routes to "general" as the safety-net default', () => {
    const ctx = resolveWelcomeContext({ source: 'homepage_footer_form' });
    expect(ctx.segment).toBe('general');
    expect(ctx.toolKey).toBeNull();
  });
});

describe('resolveWelcomeContext — corrupted-only job signal falls through to general', () => {
  it('does not route to "job" when the only job signal is a corrupted job_company and there is no job source_cta/source', () => {
    const ctx = resolveWelcomeContext({
      job_company: '). Vorab erhältst du einen Überblick über Ablauf und Lernziele – so weißt du immer, was dich erwartet und was du für deine berufliche Zukunf',
      source: 'homepage_footer_form',
    });
    expect(ctx.segment).toBe('general');
    expect(ctx.company).toBeNull();
  });

  it('does not route to "job" when job_company is corrupted and there is no source at all', () => {
    const ctx = resolveWelcomeContext({
      job_company: ', Planung und Durchführung von Communities, Trainings und Workshops hilfst du aktiv mit Du übernimmst ad-hoc Aufgaben im Team, um flexibel u',
    });
    expect(ctx.segment).toBe('general');
    expect(ctx.company).toBeNull();
  });
});

describe('resolveWelcomeContext — never throws, always sane', () => {
  it.each([null, undefined, {}, [], 42, 'a string', true])('does not throw for %j', (input) => {
    expect(() => resolveWelcomeContext(input as never)).not.toThrow();
  });

  it('returns segment "general" and all-null slots for every degenerate input', () => {
    for (const input of [null, undefined, {}, [], 42]) {
      const ctx = resolveWelcomeContext(input as never);
      expect(ctx.segment).toBe('general');
      expect(ctx.firstName).toBeNull();
      expect(ctx.company).toBeNull();
      expect(ctx.sectorKey).toBeNull();
      expect(ctx.locationLabel).toBeNull();
      expect(ctx.jobBackPath).toBeNull();
      expect(ctx.toolKey).toBeNull();
      expect(ctx.acquisitionSource).toBeNull();
    }
  });

  it('never throws for a doc with numeric/array field values', () => {
    const weirdDoc = {
      firstName: 42,
      name: ['not', 'a', 'string'],
      job_company: { nested: true },
      sector_interest: 7,
      location_interest: ['ti', 'vd'],
      source_page: 12345,
      source: ['job_board_email_unlock'],
      source_cta: {},
    };
    expect(() => resolveWelcomeContext(weirdDoc as never)).not.toThrow();
    const ctx = resolveWelcomeContext(weirdDoc as never);
    expect(WELCOME_SEGMENTS).toContain(ctx.segment);
  });

  it('every slot on a fully-corrupted doc is strictly null, never an empty string', () => {
    const corruptedDoc = {
      firstName: 'P.F.',
      name: 'Tenuta Ferraro srl',
      job_company: '). Vorab erhältst du einen Überblick über Ablauf und Lernziele – so weißt du immer, was dich erwartet und was du für deine berufliche Zukunf',
      sector_interest: 'en in elf Ländern weltweit. Seit dem',
      location_interest: 'en in elf Ländern weltweit. Seit dem',
      source_page: '/',
    };
    const ctx = resolveWelcomeContext(corruptedDoc);
    expect(ctx.segment).toBe('general');
    for (const [key, value] of Object.entries(ctx)) {
      if (key === 'segment') continue;
      // Every other slot on a fully-corrupted doc must be strictly null —
      // never an empty string, never the string "undefined"/"null".
      expect(value).toBeNull();
    }
  });

  // Idempotence: normalize(normalize(x)) === normalize(x). Five canonical keys
  // used to return null when fed back in, which would demote a subscriber from
  // the `job` segment to `general` the day a writer stored the canonical value.
  it.each(['health', 'admin', 'retail', 'hospitality', 'logistics', 'finance', 'tech', 'industry', 'education', 'construction', 'transport', 'cleaning', 'other'])(
    'normalizeSector is idempotent for the canonical key "%s"',
    (key) => {
      expect(normalizeSector(key)).toBe(key);
    },
  );
});
