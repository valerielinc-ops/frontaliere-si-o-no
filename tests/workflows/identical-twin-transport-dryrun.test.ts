import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error — .mjs senza tipi, come corpus-ahead-check.mjs.
import { classifyForTransport } from '../../scripts/ci/identical-twin-transport-dryrun.mjs';

/**
 * Il piano di verifica del proprietario (corpus#331, 2026-08-14) elenca cinque
 * controlli. Questo script copre il 2 (dry-run guidato dal manifest) e riusa
 * il 4 (fail-closed sui non dichiarati, gia' provato da
 * corpus-ahead-check.test.ts per la direzione opposta). Questi test valgono
 * sulla FORMA della classificazione — non e' "il" trasporto, e' il dry-run
 * che decide cosa sarebbe sicuro trasportare oggi, senza scrivere nulla.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = 'scripts/ci/identical-twin-transport-dryrun.mjs';

const identicalEntry = (over: Record<string, unknown> = {}) => ({
  path: 'generator/scripts/lib/ai-models.mjs',
  sitePath: 'scripts/lib/ai-models.mjs',
  mode: 'identical',
  ...over,
});

const BASE = { site: 'aaaaaaaaaaaaaaaa', corpus: 'bbbbbbbbbbbbbbbb' };

describe('lo script del dry-run esiste', () => {
  it('e sta sul sito, non nel corpus (e qui che deve girare il trasporto)', () => {
    expect(fs.existsSync(path.join(ROOT, SCRIPT)), `${SCRIPT} manca`).toBe(true);
  });
});

describe('classifyForTransport — controllo 3: gli `adapted` non sono mai candidati', () => {
  it('un file `adapted` esce `not-eligible-adapted` anche se gli hash coincidono', () => {
    const entry = identicalEntry({ mode: 'adapted', reason: 'diverge per costruzione' });
    const now = { site: 'zzzzzzzzzzzzzzzz', corpus: 'zzzzzzzzzzzzzzzz' };
    const r = classifyForTransport(entry, now, BASE);
    expect(r.transport).toBe('not-eligible-adapted');
  });

  it('un file `corpus-only` esce `not-eligible-mode`, mai `ready`', () => {
    const entry = identicalEntry({ mode: 'corpus-only' });
    const r = classifyForTransport(entry, { site: null, corpus: null }, null);
    expect(r.transport).toBe('not-eligible-mode');
  });
});

describe('classifyForTransport — controllo 2: dry-run guidato dal manifest, non dalla directory', () => {
  it('`site-ahead` (il sito si e\' mosso, il corpus no) e\' `ready`: e\' esattamente il gemello da trasportare', () => {
    const entry = identicalEntry();
    const now = { site: 'cccccccccccccccc', corpus: BASE.corpus };
    const r = classifyForTransport(entry, now, BASE);
    expect(r.state).toBe('site-ahead');
    expect(r.transport).toBe('ready');
  });

  it('`stable` (nessuno dei due si e\' mosso) non ha nulla da trasportare', () => {
    const entry = identicalEntry();
    const r = classifyForTransport(entry, BASE, BASE);
    expect(r.transport).toBe('no-op');
  });

  it('`corpus-ahead` non e\' `ready`: quella direzione la serve corpus-ahead-check.mjs, non questo script', () => {
    const entry = identicalEntry();
    const now = { site: BASE.site, corpus: 'dddddddddddddddd' };
    const r = classifyForTransport(entry, now, BASE);
    expect(r.state).toBe('corpus-ahead');
    expect(r.transport).toBe('no-op');
  });

  it('`both-moved` blocca esplicitamente: due modifiche indipendenti non si riconciliano da sole', () => {
    const entry = identicalEntry();
    const now = { site: 'cccccccccccccccc', corpus: 'dddddddddddddddd' };
    const r = classifyForTransport(entry, now, BASE);
    expect(r.state).toBe('both-moved');
    expect(r.transport).toBe('blocked-both-moved');
    expect(r.detail).toBeTruthy();
  });

  it('nessuna baseline registrata non e\' azionabile: il confronto a tre vie e\' indecidibile senza di essa', () => {
    const entry = identicalEntry();
    const now = { site: 'cccccccccccccccc', corpus: 'dddddddddddddddd' };
    const r = classifyForTransport(entry, now, null);
    expect(r.state).toBe('no-baseline');
    expect(r.transport).toBe('no-op');
  });
});
