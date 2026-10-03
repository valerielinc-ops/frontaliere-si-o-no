/**
 * Galenica crawler — Swiss-item filter tests.
 *
 * Sibling fix of the UBS resolveSwissLocation guard (see
 * tests/ubs-crawler.test.ts) — issue #3055 item 3 (item 2 is the UBS
 * counterpart). Both `inferAnyCanton(city)` branches used to bypass their
 * respective region/state validity check, so a foreign job whose city name
 * happens to alias a Swiss canton could incorrectly survive as Swiss.
 *
 * Importing update-galenica-jobs.mjs is safe: its `main()` call is guarded by
 * `process.argv[1] === fileURLToPath(import.meta.url)`, so importing it for
 * `isSwissGalenicaItem` does not trigger a live crawl.
 */
import { describe, it, expect } from 'vitest';

import {
  buildGalenicaJob,
  buildGalenicaSoliqueDescription,
  galenicaWorkLocation,
  galenicaWorkplaceLine,
  isGalenicaCompanyBlurb,
  isSwissGalenicaItem,
  mergeGalenicaRecords,
  partitionGalenicaJobs,
  resolveGalenicaCanton,
} from '../scripts/update-galenica-jobs.mjs';
import { SWISS_CANTONS } from '../scripts/lib/crawler-location-config.mjs';

describe('isSwissGalenicaItem (issue #3055 item 3)', () => {
  it('rejects a populated non-Swiss state even when the city aliases a Swiss canton', () => {
    // "Lugano" resolves to TI via the shared inferAnyCanton fuzzy city-name
    // match. "BY" (Bavaria) is a populated, clearly non-Swiss state code.
    // Pre-fix this item would have survived the filter purely on the city
    // alias, ignoring the foreign state. Post-fix it must be rejected.
    const item = { contact: { state: 'BY', city: 'Lugano' } };
    expect(SWISS_CANTONS.BY).toBeUndefined(); // sanity: not a Swiss canton code
    expect(isSwissGalenicaItem(item)).toBe(false);
  });

  it('keeps an item with a recognized Swiss canton state', () => {
    const item = { contact: { state: 'TI', city: 'Bellinzona' } };
    expect(isSwissGalenicaItem(item)).toBe(true);
  });

  it('uses an unambiguous city when the populated contact state conflicts', () => {
    expect(resolveGalenicaCanton({ state: 'TI', city: 'Zürich' })).toBe('ZH');
  });

  it('keeps an item with a blank state and a Swiss city alias (no regression)', () => {
    const item = { contact: { state: '', city: 'Lugano' } };
    expect(isSwissGalenicaItem(item)).toBe(true);
  });

  it('rejects an item with a blank state and a non-Swiss city', () => {
    const item = { contact: { state: '', city: 'Berlin' } };
    expect(isSwissGalenicaItem(item)).toBe(false);
  });

  it('accepts Swiss localities resolved through the source canton', () => {
    expect(isSwissGalenicaItem({ contact: { state: 'VD', city: 'Blonay' } })).toBe(true);
    expect(isSwissGalenicaItem({ contact: { state: 'BE', city: 'Wabern' } })).toBe(true);
  });

  it('rejects an explicit foreign country even when the city aliases Switzerland', () => {
    expect(isSwissGalenicaItem({ contact: { country: 'IT', state: '', city: 'Lugano' } })).toBe(false);
  });
});

describe('Galenica source city/state consistency (issue #11049)', () => {
  const SION_SOURCE_STATE_MISMATCH = {
    id: '3138488.4071080',
    lang: 'it',
    contact: { firm: 'Galenica AG', street: 'Untermattweg 8', zip: '3001', city: 'Bern', state: 'VD' },
    textblocks: {
      jobtitle: 'Farmacista',
      worklocationaddress: '<b>Farmacia Galenica Sion</b><br/>Rue de Lausanne 12<br/>1950 Sion',
      worklocationbranch: 'Farmacia Galenica Sion',
      georegion: 'CH-VD',
      canton: 'VD',
    },
  };

  const MOUTIER_SOURCE_STATE_MISMATCH = {
    id: '12692287',
    lang: 'it',
    contact: {
      firm: 'Amavita',
      street: 'Centre Coop, Rue Industrielle 16',
      zip: '2740',
      city: 'Moutier',
      state: 'BE',
    },
    textblocks: { jobtitle: 'Assistente di farmacia AFC' },
  };

  it('resolves the Solique Sion address from the city, not the stale source state', () => {
    const location = galenicaWorkLocation(SION_SOURCE_STATE_MISMATCH);
    expect(location).toMatchObject({ city: 'Sion', state: 'VD' });
    expect(resolveGalenicaCanton(location)).toBe('VS');
    expect(buildGalenicaJob([SION_SOURCE_STATE_MISMATCH]).job).toMatchObject({
      location: 'Sion',
      canton: 'VS',
      addressRegion: 'VS',
    });
  });

  it('resolves the Moutier apprenticeship from the city, not the contact state', () => {
    const location = galenicaWorkLocation(MOUTIER_SOURCE_STATE_MISMATCH);
    expect(location).toMatchObject({ city: 'Moutier', state: 'BE' });
    expect(resolveGalenicaCanton(location)).toBe('JU');
    expect(buildGalenicaJob([MOUTIER_SOURCE_STATE_MISMATCH]).job).toMatchObject({
      location: 'Moutier',
      canton: 'JU',
      addressRegion: 'JU',
    });
  });
});

// Minimized from the live Solique feed (jobs.galenica.com …/solique/scripts/data.json,
// id 3136693.4067072, 2026-09-29): `contact` is the RECRUITER (always Galenica AG,
// Untermattweg 8, 3001 Bern); the branch and its address live in the textblocks.
const SOLIQUE_VACANCY = {
  id: '3136693.4067072',
  lang: 'de',
  publication: { start: '2026-09-19' },
  contact: { firm: 'Galenica AG', street: 'Untermattweg 8', zip: '3001', city: 'Bern' },
  textblocks: {
    jobtitle: 'Pharma-Assistent / Pharma-Assistentin (w/m/d)',
    introductorytext: '',
    taskstitle: 'Das kannst du bewirken',
    tasks: '<ul><li>Die kompetente Beratung unserer Kundinnen und Kunden liegt dir am Herzen – du gibst ihnen jederzeit ein willkommenes Gefühl</li><li>Dein Fachwissen teilst du gerne mit dem ganzen Team</li></ul>',
    profiletitle: 'Das bringst du mit',
    profile: '<ul><li>Abgeschlossene Ausbildung als Pharma-Assistent/in oder PTA </li><li>Deutsch mindestens Niveau B2</li></ul>',
    additionalinformation: '',
    workingenvironmenttitle: 'Arbeitswelt',
    workingenvironment: '',
    benefitstitle: 'Das bieten wir dir',
    benefit1text: '<b>5 Wochen Ferien</b>, mit der Möglichkeit bis zu 10 Ferientage zusätzlich zu kaufen oder unbezahlten Urlaub zu nehmen',
    benefit2text: '<b>Diverse Rabatte</b> in unseren Apotheken und bei weiteren Top-Marken',
    benefit3text: '',
    benefitstext: 'Benefits können je nach Bereich / Stelle leicht abweichen',
    aboutustitle: 'Über uns',
    aboutus: '<b>Das grösste Apothekennetz</b><br/>Amavita ist ein Unternehmen im Galenica Netzwerk.',
    worklocationtitle: 'Arbeitsort',
    worklocationaddress: '<b>Amavita Apotheke im Bahnhof Thun</b><br/>Seestrasse 2<br/>3600 Thun',
    worklocationbranch: 'Amavita Apotheke im Bahnhof Thun',
    location: '3600 Thun',
    georegion: '',
    canton: '',
    contacttext: 'Ist das die passende Stelle für dich? Dann bewirb dich direkt über unser Online-Tool.',
    emailsubject: 'Interessante Stellenausschreibung bei Amavita',
  },
};

// Apprenticeship items of the same feed carry only a title and a Yousty link;
// their contact IS the branch.
const APPRENTICESHIP_VARIANTS = [
  { id: '12692283', lang: 'de', contact: { firm: 'Amavita', street: 'Place du Lignon 19', zip: '1219', city: 'Le Lignon', state: 'GE' }, textblocks: { jobtitle: 'Fachmann/-frau Apotheke EFZ (alt Pharma-Assistent/in EFZ)', profilelink: 'https://www.yousty.ch/de-CH/lehrstellen/profile/12692283-fachmann-frau-apotheke-efz-le-lignon-ge-amavita' } },
  { id: '12692283', lang: 'it', contact: { firm: 'Amavita', street: 'Place du Lignon 19', zip: '1219', city: 'Le Lignon', state: 'GE' }, textblocks: { jobtitle: 'Assistente di farmacia AFC', profilelink: 'https://www.yousty.ch/de-CH/lehrstellen/profile/12692283-fachmann-frau-apotheke-efz-le-lignon-ge-amavita' } },
];

// Yousty profile text of 12692278 (Amavita Lausanne), 2026-09-29 — the same text
// Amavita publishes for every Lausanne pharmacy; only the workplace differs.
const YOUSTY_TEXT = [
  'Tu t’intéresses à une place d’apprentissage en tant qu’Assistante / Assistant en pharmacie CFC ? Youpi ! 🥳',
  'Amavita est le plus grand réseau de pharmacies de Suisse et accompagne au quotidien les personnes pour toutes les questions liées à la santé et au bien-être. Grâce à nos nombreux points de vente répartis dans toute la Suisse, nous sommes proches de nos clientes et clients.',
  'Ce qui t’attend chez nous:',
  '- Tu conseilles et accompagnes notre clientèle et lui fais toujours sentir qu’elle est la bienvenue',
  '- Tu renseignes sur les médicaments, les produits de soins ainsi que les remèdes naturels',
].join('\n\n');

const LEGACY_BLURB = 'Assistente di farmacia AFC presso Amavita (Gruppo Galenica), con sede a Lausanne, Place St-François 5, Svizzera. Galenica è il principale gruppo svizzero nel settore sanitario e gestisce la più grande rete di farmacie del Paese, con i marchi Amavita, Sun Store e Coop Vitality.';

function apprenticeship(id: string, street: string, zip: string) {
  const contact = { firm: 'Amavita', street, zip, city: 'Lausanne', state: 'VD' };
  return [
    { id, lang: 'fr', contact, textblocks: { jobtitle: 'Assistant/e en pharmacie CFC', profilelink: `https://www.yousty.ch/fr-CH/places-d-apprentissage/profils/${id}-assistant-e-en-pharmacie-cfc-lausanne-vd-amavita` } },
    { id, lang: 'it', contact, textblocks: { jobtitle: 'Assistente di farmacia AFC', profilelink: `https://www.yousty.ch/de-CH/lehrstellen/profile/${id}-fachmann-frau-apotheke-efz-lausanne-vd-amavita` } },
  ];
}

const withYousty = (variants: ReturnType<typeof apprenticeship>) => buildGalenicaJob(variants, {
  youstyEnrichment: { description: YOUSTY_TEXT, sourceLang: 'fr', applyUrl: variants[0].textblocks.profilelink },
});

describe('Galenica Solique content (flat 243/249: the blurb replaced the posting)', () => {
  it('publishes tasks, profile and benefits as markdown lists, without contact/apply chrome', () => {
    const md = buildGalenicaSoliqueDescription(SOLIQUE_VACANCY.textblocks);
    expect(md).toContain('## Das kannst du bewirken\n\n- Die kompetente Beratung unserer Kundinnen und Kunden');
    expect(md).toContain('## Das bringst du mit\n\n- Abgeschlossene Ausbildung als Pharma-Assistent/in oder PTA\n- Deutsch mindestens Niveau B2');
    expect(md).toContain('- 5 Wochen Ferien, mit der Möglichkeit bis zu 10 Ferientage');
    expect(md).not.toMatch(/Online-Tool|Stellenausschreibung bei/);
    expect(isGalenicaCompanyBlurb(md)).toBe(false);
  });

  it('returns nothing for an apprenticeship stub without tasks or profile', () => {
    expect(buildGalenicaSoliqueDescription(APPRENTICESHIP_VARIANTS[0].textblocks)).toBe('');
  });

  it('locates a vacancy at its branch, not at the recruiter address', () => {
    expect(galenicaWorkLocation(SOLIQUE_VACANCY)).toMatchObject({ city: 'Thun', zip: '3600', street: 'Seestrasse 2', branch: 'Amavita Apotheke im Bahnhof Thun' });
    expect(galenicaWorkLocation(APPRENTICESHIP_VARIANTS[0])).toMatchObject({ city: 'Le Lignon', state: 'GE' });
    expect(isSwissGalenicaItem(SOLIQUE_VACANCY)).toBe(true);
  });

  it('opens the vacancy with the branch line in the language of the body', () => {
    const { job } = buildGalenicaJob([SOLIQUE_VACANCY]);
    expect(job.location).toBe('Thun');
    expect(job.canton).toBe('BE');
    expect(job.sourceLang).toBe('de');
    expect(Object.keys(job.descriptionByLocale)).toEqual(['de']);
    expect(job.description).toMatch(/^\*\*Arbeitsort:\*\* Amavita Apotheke im Bahnhof Thun, Seestrasse 2, 3600 Thun\n\n## Das kannst du bewirken/);
    expect(galenicaWorkplaceLine({ branch: 'Amavita', street: 'Place du Lignon 19', zip: '1219', city: 'Le Lignon' }, 'it'))
      .toBe('**Luogo di lavoro:** Amavita, Place du Lignon 19, 1219 Le Lignon');
  });

  it('keeps the Yousty text as source-locale content, after the workplace line', () => {
    const { job, thinSourceDescription } = withYousty(apprenticeship('12692278', 'Route des Plaines-du-Loup 2', '1018'));
    expect(thinSourceDescription).toBeUndefined();
    expect(job.title).toBe('Assistente di farmacia AFC');
    expect(job.sourceLang).toBe('fr');
    expect(job.description).toBe(`**Lieu de travail:** Amavita, Route des Plaines-du-Loup 2, 1018 Lausanne\n\n${YOUSTY_TEXT}`);
    expect(job.descriptionByLocale).toEqual({ fr: job.description });
    expect(job.descriptionIt).toBeUndefined();
  });

  it('never builds a blurb: no source text → flagged, empty description', () => {
    const result = buildGalenicaJob(APPRENTICESHIP_VARIANTS, { youstyEnrichment: { applyUrl: 'x' } });
    expect(result.noSourceDescription).toBe(true);
    expect(result.job.description).toBe('');
    expect(result.job.descriptionByLocale).toEqual({});
  });

  it('flags a source text under 50 words as thin', () => {
    const short = buildGalenicaJob(APPRENTICESHIP_VARIANTS, {
      youstyEnrichment: { description: 'Wir bieten eine abwechslungsreiche und spannende Lehrstelle als Drogist/in EFZ.', sourceLang: 'de', applyUrl: 'x' },
    });
    expect(short.thinSourceDescription).toBe(true);
  });
});

describe('Galenica run partition and merge', () => {
  it('keeps distinct branches of one city apart and collapses a true republication onto the lowest id', () => {
    const a = withYousty(apprenticeship('12692278', 'Route des Plaines-du-Loup 2', '1018'));
    const b = withYousty(apprenticeship('12692200', 'Place St-François 5', '1003'));
    const republished = withYousty(apprenticeship('12692299', 'Place St-François 5', '1003'));
    const { jobs, dropped } = partitionGalenicaJobs([a, republished, b]);
    expect(jobs.map((j) => j.url)).toEqual([a.job.url, b.job.url]);
    expect(dropped.map((d) => [d.dropped.url, d.kept.url])).toEqual([[republished.job.url, b.job.url]]);
  });

  it('keeps a stored source text when none was read, drops blurb-only records, keeps collapsed slugs as redirects', () => {
    const fresh = withYousty(apprenticeship('12692278', 'Route des Plaines-du-Loup 2', '1018'));
    const kept = withYousty(apprenticeship('12692200', 'Place St-François 5', '1003'));
    const republished = withYousty(apprenticeship('12692299', 'Place St-François 5', '1003'));
    const noText = buildGalenicaJob(apprenticeship('12692300', 'Rue de Bourg 8', '1003'), { youstyEnrichment: { applyUrl: 'x' } });
    const blurbOnly = buildGalenicaJob(apprenticeship('12692301', 'Rue du Petit-Chêne 38', '1003'), { youstyEnrichment: { applyUrl: 'x' } });
    const stored = [
      { ...fresh.job, description: LEGACY_BLURB, descriptionByLocale: { it: LEGACY_BLURB, fr: LEGACY_BLURB }, sourceLang: 'it', slug: 'old-12692278' },
      { ...kept.job, slug: 'kept-12692200' },
      { ...republished.job, slug: 'republished-12692299', slugByLocale: { it: 'republished-12692299' } },
      { ...noText.job, description: YOUSTY_TEXT, sourceLang: 'fr', descriptionByLocale: { fr: YOUSTY_TEXT }, slug: 'notext-12692300' },
      { ...blurbOnly.job, description: LEGACY_BLURB, sourceLang: 'it', descriptionByLocale: { it: LEGACY_BLURB }, slug: 'blurb-12692301' },
    ];
    const discovery = partitionGalenicaJobs([fresh, kept, republished, noText, blurbOnly]);
    const { jobs, stats } = mergeGalenicaRecords(stored, discovery);
    const byId = Object.fromEntries(jobs.map((j) => [j.url.split('=')[1], j]));
    expect(Object.keys(byId).sort()).toEqual(['12692200', '12692278', '12692300']);
    expect(stats.unpublished.map((j: { url: string }) => j.url.split('=')[1])).toEqual(['12692301']);
    expect(byId['12692278'].description.startsWith('**Lieu de travail:**')).toBe(true);
    expect(Object.values(byId['12692278'].descriptionByLocale).some((t) => isGalenicaCompanyBlurb(String(t)))).toBe(false);
    expect(byId['12692300'].description).toBe(YOUSTY_TEXT);
    expect(JSON.stringify(byId['12692200'].previousSlugsByLocale || byId['12692200'].previousSlugs || {})).toContain('republished-12692299');
  });
});
