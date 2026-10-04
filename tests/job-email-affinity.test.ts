// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  AFFINITY_HALF_LIFE_DAYS,
  AFFINITY_MAX_VALUES_PER_DIMENSION,
  AFFINITY_MIN_CLICKS,
  AFFINITY_TTL_DAYS,
  affinityDocId,
  applyAffinityClick,
  emptyAffinityProfile,
  hasAffinityProfile,
  isStoppedFromAllEmail,
  scoreJobAffinity,
} from '../functions/src/lib/jobEmailAffinity.js';
import { pseudonymousUserId } from '../functions/src/lib/jobEmailRanking.js';
import { jobManifestEntry } from '../functions/src/lib/jobEmailRankingStore.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1, 8, 0, 0);
const at = (days: number) => new Date(T0 + days * DAY);
const job = { category: 'Informatica', canton: 'TI', company_key: 'acme', sector: 'tech' };

function weightOf(profile: any, dimension: string, key: string) {
  return profile.dimensions[dimension].find((entry: any) => entry.key === key)?.weight ?? 0;
}

describe('affinityDocId', () => {
  it('e lo pseudonimo HMAC dei dati di ranking, e non esiste senza segreto', () => {
    expect(affinityDocId(' Persona@Example.com ', 's3cret')).toBe(pseudonymousUserId('persona@example.com', 's3cret'));
    expect(affinityDocId('persona@example.com', '')).toBeNull();
    expect(affinityDocId('persona@example.com', undefined)).toBe(
      process.env.NEWSLETTER_SECRET ? pseudonymousUserId('persona@example.com', process.env.NEWSLETTER_SECRET) : null,
    );
  });
});

describe('applyAffinityClick', () => {
  it('somma 1 sui quattro valori, aggiorna clic e date, scade 180 giorni dopo l ultimo clic', () => {
    const profile = applyAffinityClick(emptyAffinityProfile('pid'), job, at(0));
    expect(profile.clicks).toBe(1);
    expect(profile.last_click_at.getTime()).toBe(T0);
    expect(profile.expires_at.getTime()).toBe(T0 + AFFINITY_TTL_DAYS * DAY);
    expect(weightOf(profile, 'category', 'informatica')).toBe(1);
    expect(weightOf(profile, 'canton', 'TI')).toBe(1);
    expect(weightOf(profile, 'company_key', 'acme')).toBe(1);
    expect(weightOf(profile, 'sector', 'tech')).toBe(1);
    // Solo le chiavi documentate: niente email, uid o URL.
    expect(Object.keys(profile).sort()).toEqual(
      ['clicks', 'dimensions', 'expires_at', 'last_click_at', 'updated_at', 'user_id', 'version'],
    );
  });

  it('decade il peso esistente con emivita di 45 giorni', () => {
    const first = applyAffinityClick(emptyAffinityProfile('pid'), job, at(0));
    const second = applyAffinityClick(first, { ...job, category: 'Edilizia' }, at(AFFINITY_HALF_LIFE_DAYS));
    expect(weightOf(second, 'category', 'informatica')).toBeCloseTo(0.5, 5);
    expect(weightOf(second, 'category', 'edilizia')).toBe(1);
    expect(weightOf(second, 'canton', 'TI')).toBeCloseTo(1.5, 5);
    expect(second.expires_at.getTime()).toBe(T0 + (AFFINITY_HALF_LIFE_DAYS + AFFINITY_TTL_DAYS) * DAY);
  });

  it('un clic non piu recente dell ultimo applicato non conta di nuovo', () => {
    const first = applyAffinityClick(emptyAffinityProfile('pid'), job, at(1));
    expect(applyAffinityClick(first, job, at(1))).toBe(first);
    expect(applyAffinityClick(first, job, at(0))).toBe(first);
  });

  it('un annuncio senza caratteristiche lascia il profilo invariato', () => {
    const empty = emptyAffinityProfile('pid');
    expect(applyAffinityClick(empty, { category: null, canton: 'Ticino', company_key: '', sector: '  ' }, at(0))).toBe(empty);
  });

  it('tiene al massimo 30 valori per dimensione, i piu pesanti', () => {
    let profile = applyAffinityClick(emptyAffinityProfile('pid'), { category: 'preferita' }, at(0));
    profile = applyAffinityClick(profile, { category: 'preferita' }, at(0.001));
    for (let index = 0; index < 40; index += 1) {
      profile = applyAffinityClick(profile, { category: `cat-${index}` }, at(1 + index * 0.001));
    }
    const categories = profile.dimensions.category;
    expect(categories).toHaveLength(AFFINITY_MAX_VALUES_PER_DIMENSION);
    expect(categories[0].key).toBe('preferita');
    expect(categories.some((entry: any) => entry.key === 'cat-39')).toBe(true);
    expect(categories.some((entry: any) => entry.key === 'cat-0')).toBe(false);
  });
});

describe('hasAffinityProfile', () => {
  it('vuole almeno 2 clic e un profilo non scaduto', () => {
    const one = applyAffinityClick(emptyAffinityProfile('pid'), job, at(0));
    expect(AFFINITY_MIN_CLICKS).toBe(2);
    expect(hasAffinityProfile(one, at(1))).toBe(false);
    const two = applyAffinityClick(one, job, at(1));
    expect(hasAffinityProfile(two, at(2))).toBe(true);
    expect(hasAffinityProfile(two, at(1 + AFFINITY_TTL_DAYS - 0.01))).toBe(true);
    expect(hasAffinityProfile(two, at(1 + AFFINITY_TTL_DAYS))).toBe(false);
    expect(hasAffinityProfile(null, at(2))).toBe(false);
    expect(hasAffinityProfile({ ...two, version: 99 }, at(2))).toBe(false);
  });
});

describe('scoreJobAffinity', () => {
  const twoClicks = applyAffinityClick(applyAffinityClick(emptyAffinityProfile('pid'), job, at(0)), job, at(0.5));

  it('vale 1 su un annuncio identico ai clic e 0 senza profilo valido', () => {
    expect(scoreJobAffinity(twoClicks, job, at(1))).toBeCloseTo(1, 6);
    const oneClick = applyAffinityClick(emptyAffinityProfile('pid'), job, at(0));
    expect(scoreJobAffinity(oneClick, job, at(1))).toBe(0);
    expect(scoreJobAffinity(null, job, at(1))).toBe(0);
  });

  it('pesa categoria 0,4 e le altre tre 0,2', () => {
    expect(scoreJobAffinity(twoClicks, { ...job, category: 'altro' }, at(1))).toBeCloseTo(0.6, 6);
    expect(scoreJobAffinity(twoClicks, { ...job, canton: 'ZH' }, at(1))).toBeCloseTo(0.8, 6);
  });

  it('rinormalizza sulle sole dimensioni presenti nel profilo', () => {
    const onlyCategory = applyAffinityClick(
      applyAffinityClick(emptyAffinityProfile('pid'), { category: 'informatica' }, at(0)),
      { category: 'edilizia' },
      at(0.5),
    );
    // Solo la categoria ha dati: il punteggio e' la sua quota, senza diluirsi.
    expect(scoreJobAffinity(onlyCategory, { category: 'Informatica', canton: 'TI' }, at(0.5))).toBeCloseTo(
      Math.pow(0.5, 0.5 / AFFINITY_HALF_LIFE_DAYS) / (1 + Math.pow(0.5, 0.5 / AFFINITY_HALF_LIFE_DAYS)),
      6,
    );
  });

  it('un annuncio senza caratteristiche vale 0', () => {
    expect(scoreJobAffinity(twoClicks, {}, at(1))).toBe(0);
    expect(scoreJobAffinity(twoClicks, null, at(1))).toBe(0);
  });

  it('accetta la forma di jobManifestEntry, come la usera il passo di ordinamento', () => {
    const manifest = jobManifestEntry({ jobId: 'j1', category: 'Informatica', canton: 'ti', companyKey: 'acme', sector: 'tech' }, 0);
    expect(scoreJobAffinity(twoClicks, manifest, at(1))).toBeCloseTo(1, 6);
  });

  it('resta tra 0 e 1', () => {
    for (const attrs of [job, { category: 'x' }, { canton: 'TI' }, { sector: 'tech', company_key: 'acme' }]) {
      const score = scoreJobAffinity(twoClicks, attrs, at(10));
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

describe('isStoppedFromAllEmail', () => {
  it('distingue la disiscrizione da tutto da quella parziale', () => {
    expect(isStoppedFromAllEmail({ newsletter: { status: 'unsubscribed' }, jobAlert: { status: 'active' } })).toBe(true);
    expect(isStoppedFromAllEmail({ newsletter: { status: 'confirmed', global_email_opt_out: true } })).toBe(true);
    expect(isStoppedFromAllEmail({ newsletter: { status: 'confirmed' }, jobAlert: { status: 'complained' } })).toBe(true);
    expect(isStoppedFromAllEmail({ newsletter: { status: 'confirmed' }, jobAlert: null })).toBe(false);
    expect(isStoppedFromAllEmail({ newsletter: { status: 'inactive' }, jobAlert: { status: 'active' } })).toBe(false);
    expect(isStoppedFromAllEmail({ newsletter: { status: 'inactive' }, jobAlert: null })).toBe(true);
    expect(isStoppedFromAllEmail({ newsletter: null, jobAlert: null })).toBe(true);
  });
});
