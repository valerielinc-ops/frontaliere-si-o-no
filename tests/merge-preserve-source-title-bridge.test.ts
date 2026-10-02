import { describe, expect, it } from 'vitest';
import { buildSourceTitleBridge, mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
import { extractStableJobId } from '../scripts/lib/job-match-key.mjs';
import { liebherrMatchKey } from '../scripts/lib/liebherr-job-parser.mjs';

/**
 * A re-crawl must keep the translations of a job whose source title did not
 * change, also when its match key did.
 *
 * Real case, sanitized (descriptions cut to their opening sentence): abraxas,
 * crawler group 13, corpus run 36841309578 (2026-10-01). The employer reposted
 * "Abacus Berater:in BPE, REST & AbaReport 80–100 %" under a new URL id
 * (-2411 → -4304); the crawler counted it as new and the site published the
 * German title under /it/, /en/ and /fr/ (site commit 5fe4ef6a2).
 */

const ABRAXAS_DE_DESC = 'Dich begeistert es, wenn Systeme miteinander sprechen, Daten intelligent genutzt werden und aus Anforderungen funktionierende Lösungen entstehen?';
const TITLE = 'Abacus Berater:in BPE, REST & AbaReport 80–100 %';

function abraxasStored() {
  return {
    id: 'abraxas-e12391c35b27',
    url: 'https://www.abraxas.ch/de/karriere/offene-stellen/abacus-beraterin-bpe-rest-amp-abareport-80-100-2411',
    title: TITLE,
    titleByLocale: {
      it: 'Consulente Abacus BPE, REST & AbaReport 80-100%',
      en: 'Abacus consultant BPE, REST & AbaReport 80-100%',
      de: TITLE,
      fr: 'Consultant en Abacus: dans BPE, REST & AbaReport 80-100%',
    },
    description: ABRAXAS_DE_DESC,
    descriptionByLocale: {
      it: 'Sei entusiasta quando i sistemi si parlano a vicenda, i dati vengono utilizzati in modo intelligente e le soluzioni nascono dai requisiti?',
      en: 'Are you thrilled when systems talk to each other, data is used intelligently and solutions arise from requirements?',
      de: ABRAXAS_DE_DESC,
      fr: 'Êtes-vous ravi lorsque les systèmes se parlent, les données sont utilisées intelligemment et les solutions découlent des exigences?',
    },
    sourceLang: 'de',
    company: 'Abraxas Informatik AG',
    companyKey: 'abraxas',
    location: 'St. Gallen',
    addressLocality: 'St. Gallen',
  };
}

function abraxasRepost() {
  return {
    id: 'abraxas-223d6f6bb604',
    url: 'https://www.abraxas.ch/de/karriere/offene-stellen/abacus-beraterin-bpe-rest-amp-abareport-80-100-4304',
    title: TITLE,
    titleByLocale: { de: TITLE },
    description: ABRAXAS_DE_DESC,
    descriptionByLocale: { de: ABRAXAS_DE_DESC },
    sourceLang: 'de',
    company: 'Abraxas Informatik AG',
    companyKey: 'abraxas',
    location: 'St. Gallen',
    addressLocality: 'St. Gallen',
  };
}

const NOW = Date.parse('2026-10-01T09:20:00Z');

describe('mergePreserveLocaleData: unchanged source title, changed match key', () => {
  it('the abraxas repost really changes the default match key', () => {
    expect(extractStableJobId(abraxasStored().url)).not.toBe(extractStableJobId(abraxasRepost().url));
  });

  it('keeps the it/en/fr translations of the abraxas repost (crawler group 13, run 36841309578)', () => {
    const [merged] = mergePreserveLocaleData([abraxasStored()], [abraxasRepost()], { retainMissingJobs: false, nowMs: NOW });

    expect(merged.url).toBe(abraxasRepost().url);
    expect(merged.id).toBe('abraxas-223d6f6bb604'); // identity is not carried: the posting is new
    expect(merged.titleByLocale).toEqual(abraxasStored().titleByLocale);
    expect(merged.descriptionByLocale).toEqual(abraxasStored().descriptionByLocale);

    // Same outcome as if the key had matched.
    const [keyMatched] = mergePreserveLocaleData(
      [abraxasStored()],
      [{ ...abraxasRepost(), url: abraxasStored().url }],
      { retainMissingJobs: false, nowMs: NOW },
    );
    expect(merged.titleByLocale).toEqual(keyMatched.titleByLocale);
    expect(merged.descriptionByLocale).toEqual(keyMatched.descriptionByLocale);
    expect(Boolean(merged.needsRetranslation)).toBe(Boolean(keyMatched.needsRetranslation));
  });

  it('keeps the translations across the liebherr match-key migration (URL key → source-job key)', () => {
    const stored = {
      ...abraxasStored(),
      id: 'liebherr-1',
      url: 'https://jobs.liebherr.com/job/Nussbaumen-Junior-Group-Controller-mwd-100/83850/',
      title: 'Junior Group Controller (m/w/d) 100%',
      titleByLocale: {
        it: 'Junior Group Controller (m/f/d) 100%',
        en: 'Junior Group Controller (m/f/d) 100%',
        de: 'Junior Group Controller (m/w/d) 100%',
        fr: 'Contrôleur de groupe junior (h/f/d) 100%',
      },
      company: 'Liebherr',
      companyKey: 'liebherr',
      location: 'Nussbaumen',
      addressLocality: 'Nussbaumen',
    };
    const fresh = {
      ...stored,
      titleByLocale: { de: stored.title },
      descriptionByLocale: { de: ABRAXAS_DE_DESC },
      sourceLocale: 'de_DE',
      liebherrSourceJobId: '83850',
    };
    expect(liebherrMatchKey(stored)).not.toBe(liebherrMatchKey(fresh));

    const [merged] = mergePreserveLocaleData([stored], [fresh], { matchKey: liebherrMatchKey, retainMissingJobs: false, nowMs: NOW });
    expect(merged.titleByLocale).toEqual(stored.titleByLocale);
  });

  it('carries nothing when the source title changed', () => {
    const fresh = { ...abraxasRepost(), title: 'Abacus Berater:in Lohn 80–100 %', titleByLocale: { de: 'Abacus Berater:in Lohn 80–100 %' } };
    const [merged] = mergePreserveLocaleData([abraxasStored()], [fresh], { retainMissingJobs: false, nowMs: NOW });

    expect(merged.titleByLocale).toEqual({ de: 'Abacus Berater:in Lohn 80–100 %' });
    expect(merged.needsRetranslation).toBe(true);
  });

  it('carries nothing to a different locality, company or source language', () => {
    for (const change of [
      { addressLocality: 'Zürich-Flughafen', location: 'Zürich-Flughafen' },
      { company: 'Other AG', companyKey: 'other' },
      { sourceLang: 'en' },
    ]) {
      const [merged] = mergePreserveLocaleData([abraxasStored()], [{ ...abraxasRepost(), ...change }], { retainMissingJobs: false, nowMs: NOW });
      expect(merged.titleByLocale, JSON.stringify(change)).toEqual({ de: TITLE });
    }
  });

  it('does not guess between two stored records with the same title and locality', () => {
    const second = { ...abraxasStored(), id: 'abraxas-other', url: abraxasStored().url.replace('-2411', '-1999') };
    const bridge = buildSourceTitleBridge([abraxasStored(), second], [abraxasRepost()], (job: { url: string }) => extractStableJobId(job.url));
    expect(bridge.size).toBe(0);
  });

  it('leaves a key match to the key merge and bridges nothing else', () => {
    const stored = abraxasStored();
    const sameKey = { ...abraxasRepost(), url: stored.url };
    const bridge = buildSourceTitleBridge([stored], [sameKey], (job: { url: string }) => extractStableJobId(job.url));
    expect(bridge.size).toBe(0);

    const [merged] = mergePreserveLocaleData([stored], [sameKey], { retainMissingJobs: false, nowMs: NOW });
    expect(merged.id).toBe(stored.id);
    expect(merged.titleByLocale).toEqual(stored.titleByLocale);
  });
});
