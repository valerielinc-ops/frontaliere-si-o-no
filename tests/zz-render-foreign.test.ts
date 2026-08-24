import { describe, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AUSTRIAN_ABOVE_FLOOR } from '@/build-plugins/austrianBorderMunicipalityData';
import { GERMAN_ABOVE_FLOOR } from '@/build-plugins/germanBorderMunicipalityData';
import { FRENCH_ABOVE_FLOOR } from '@/build-plugins/frenchBorderMunicipalityData';
import { LIECHTENSTEIN_ABOVE_FLOOR } from '@/build-plugins/liechtensteinBorderMunicipalityData';
import { renderAboveFloorPage as at } from '@/build-plugins/austrianBorderMunicipalityPagesPlugin';
import { renderAboveFloorPage as de } from '@/build-plugins/germanBorderMunicipalityPagesPlugin';
import { renderAboveFloorPage as fr } from '@/build-plugins/frenchBorderMunicipalityPagesPlugin';
import { renderAboveFloorPage as li } from '@/build-plugins/liechtensteinBorderMunicipalityPagesPlugin';

const OUT = '/private/tmp/claude-502/-Users-saggesel-Projects-frontaliere/af4901dd-2f84-4e62-9659-a2fcd7398c9b/scratchpad/distforeign';
const save = (urlPath: string, html: string) => {
  const f = join(OUT, urlPath.replace(/^\//, '').replace(/\/$/, ''), 'index.html');
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, html);
};

describe('render famiglie estere', () => {
  const fams: Array<[string, readonly any[], (p: any) => { html: string; urlPath: string }]> = [
    ['austria', AUSTRIAN_ABOVE_FLOOR, at as never],
    ['germania', GERMAN_ABOVE_FLOOR, de as never],
    ['francia', FRENCH_ABOVE_FLOOR, fr as never],
    ['liechtenstein', LIECHTENSTEIN_ABOVE_FLOOR, li as never],
  ];
  for (const [name, pool, render] of fams) {
    it(name, () => {
      console.log(`${name}: ${pool.length} comuni above-floor`);
      for (const m of pool) {
        const { html, urlPath } = render({ municipality: m, locale: 'it', dateStamp: '2026-08-24', distDir: OUT } as never);
        save(urlPath, html);
      }
    });
  }
});
