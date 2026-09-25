/**
 * Facciata Node dei contenuti newsletter: installa il lettore dei dataset e
 * ri-esporta `./newsletter-content-core.mjs`.
 *
 * Perche' esiste (#8125): i costruttori di contenuto sono condivisi fra il
 * sender (Node, legge `data/**` da disco) e la preview dell'AdminPanel
 * (browser). Finche' stavano in un solo modulo con `import fs from 'node:fs'`,
 * quel modulo era nel grafo del bundle browser — e un builtin Node nel grafo
 * fa fallire il link di rollup appena l'import passa dalla forma di default a
 * quella nominale, cioe' il difetto che ha fermato i deploy dal 2026-09-08.
 *
 * Il verso conta, e questo modulo tiene il nome storico di proposito: i
 * consumatori Node — sender, script, test — importano `newsletter-content.mjs`
 * come hanno sempre fatto, quindi il lettore e' installato prima del primo uso
 * e i file letti sono gli stessi di prima. Il rischio da chiudere era il degrado
 * silenzioso: un sender rimasto sul modulo puro spedirebbe email senza loghi ne'
 * metriche senza che niente fallisca. L'unico consumatore del browser
 * (`newsletterPreview.ts`) importa il core, ed e' l'eccezione esplicita — se
 * importasse da QUI, `node:fs` rientrerebbe nel grafo del bundle e il difetto
 * tornerebbe identico.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setNewsletterDatasetReader } from './newsletter-datasets.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

setNewsletterDatasetReader((...segments) => {
  const filePath = path.resolve(REPO_ROOT, ...segments);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
});

export * from './newsletter-content-core.mjs';
