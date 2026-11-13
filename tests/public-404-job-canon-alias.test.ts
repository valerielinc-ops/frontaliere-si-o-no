import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

type AliasResolver = (aliasPath: unknown, requestedLocale: string) => string | null;

describe('public/404.html job-canon alias locale validation', () => {
  let resolveAlias!: AliasResolver;

  beforeAll(() => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'public/404.html'), 'utf8');
    const start = source.indexOf('function jobCanonAliasTarget(');
    const end = source.indexOf('\n            var aliasTarget', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const declaration = source.slice(start, end);
    resolveAlias = new Function(`${declaration}\nreturn jobCanonAliasTarget;`)() as AliasResolver;
  });

  it('accepts aliases only inside the requested locale for all four languages', () => {
    expect(resolveAlias('/cerca-lavoro-zurigo/offerta-corrente', 'it'))
      .toBe('/cerca-lavoro-zurigo/offerta-corrente/');
    expect(resolveAlias('/en/find-jobs-zurich/current-job', 'en'))
      .toBe('/en/find-jobs-zurich/current-job/');
    expect(resolveAlias('/de/jobs-in-zurich/aktueller-job', 'de'))
      .toBe('/de/jobs-in-zurich/aktueller-job/');
    expect(resolveAlias('/fr/trouver-emploi-zurich/offre-actuelle', 'fr'))
      .toBe('/fr/trouver-emploi-zurich/offre-actuelle/');
  });

  it('rejects cross-locale and unsafe alias targets', () => {
    expect(resolveAlias('/en/find-jobs-zurich/current-job', 'it')).toBeNull();
    expect(resolveAlias('/fr/trouver-emploi-zurich/offre-actuelle', 'en')).toBeNull();
    expect(resolveAlias('//evil.example/job', 'it')).toBeNull();
    expect(resolveAlias('/en/job?next=x', 'en')).toBeNull();
    expect(resolveAlias('/en/job#fragment', 'en')).toBeNull();
    expect(resolveAlias(null, 'it')).toBeNull();
  });
});
