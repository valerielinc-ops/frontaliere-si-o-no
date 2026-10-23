import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SYNCHRONIZED_BODIES = [
  ['blog-body-ch/de/bns-cambi-energia.ts', 'bns-cambi-energia'],
  ['blog-body-ch/de/lavoro-ridotto-normalizzazione-2027.ts', 'lavoro-ridotto-normalizzazione-2027'],
  ['blog-body-ch/de/sondaggio-votazioni-novembre-svizzera.ts', 'sondaggio-votazioni-novembre-svizzera'],
  ['blog-body-ch/de/sostenibilita-abitativa-svizzera.ts', 'sostenibilita-abitativa-svizzera'],
  ['blog-body-ch/en/bns-cambi-energia.ts', 'bns-cambi-energia'],
  ['blog-body-ch/en/lavoro-ridotto-normalizzazione-2027.ts', 'lavoro-ridotto-normalizzazione-2027'],
  ['blog-body-ch/en/sondaggio-votazioni-novembre-svizzera.ts', 'sondaggio-votazioni-novembre-svizzera'],
  ['blog-body-ch/en/sostenibilita-abitativa-svizzera.ts', 'sostenibilita-abitativa-svizzera'],
  ['blog-body-ch/fr/bns-cambi-energia.ts', 'bns-cambi-energia'],
  ['blog-body-ch/fr/lavoro-ridotto-normalizzazione-2027.ts', 'lavoro-ridotto-normalizzazione-2027'],
  ['blog-body-ch/fr/sondaggio-votazioni-novembre-svizzera.ts', 'sondaggio-votazioni-novembre-svizzera'],
  ['blog-body-ch/fr/sostenibilita-abitativa-svizzera.ts', 'sostenibilita-abitativa-svizzera'],
  ['blog-body-ch/it/bns-cambi-energia.ts', 'bns-cambi-energia'],
  ['blog-body-ch/it/lavoro-ridotto-normalizzazione-2027.ts', 'lavoro-ridotto-normalizzazione-2027'],
  ['blog-body-ch/it/sondaggio-votazioni-novembre-svizzera.ts', 'sondaggio-votazioni-novembre-svizzera'],
  ['blog-body-ch/it/sostenibilita-abitativa-svizzera.ts', 'sostenibilita-abitativa-svizzera'],
  ['blog-body/de/voto-iva-2028-pensione.ts', 'voto-iva-2028-pensione'],
  ['blog-body/en/voto-iva-2028-pensione.ts', 'voto-iva-2028-pensione'],
  ['blog-body/fr/voto-iva-2028-pensione.ts', 'voto-iva-2028-pensione'],
  ['blog-body/it/voto-iva-2028-pensione.ts', 'voto-iva-2028-pensione'],
] as const;

describe('article corpus sync', () => {
  it('keeps every newly indexed article body populated', () => {
    const root = path.resolve(__dirname, '..', 'packages', 'articles', 'content');

    for (const [relativeFile, articleId] of SYNCHRONIZED_BODIES) {
      const source = fs.readFileSync(path.join(root, relativeFile), 'utf8');
      const body1 = source.match(new RegExp(`['"]blog\\.article\\.${articleId}\\.body1['"]\\s*:\\s*(['"])([\\s\\S]*?)\\1`))?.[2] ?? '';
      expect(body1.trim(), relativeFile).not.toHaveLength(0);
    }
  });
});
