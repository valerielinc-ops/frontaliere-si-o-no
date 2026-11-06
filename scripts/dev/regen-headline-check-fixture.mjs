#!/usr/bin/env node
/**
 * Rigenera lo snapshot del corpus usato da tests/pre-flight-headline-check.test.ts.
 *
 * La suite girava contro `services/locales/blog-meta-it.ts`, cioe' il registro
 * VIVO: passava e falliva sullo stesso codice a seconda di cosa la pipeline
 * avesse pubblicato nel frattempo. Ora legge una fixture ferma, e questo script
 * e' il modo di aggiornarla di proposito invece che per caso.
 *
 * Cosa preserva, e perche':
 *   - TUTTE le voci `salario-minimo`: sono il cluster su cui poggiano i quattro
 *     casi positivi, che asseriscono `existingId` contro quel prefisso.
 *   - un campione di altri articoli, per dare al calcolo di containment un
 *     corpus di forma realistica invece di quattro voci.
 *   - NIENTE che collida con le headline «unrelated» dei casi negativi: se una
 *     entrasse, il caso negativo diventerebbe un duplicato legittimo e avremmo
 *     ricreato in fixture esattamente il problema che la fixture risolve.
 *
 * Uso:
 *   node scripts/dev/regen-headline-check-fixture.mjs
 *
 * Serve il corpus materializzato: in un worktree sparse,
 *   git sparse-checkout add packages/articles/content
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SOURCE = path.join(ROOT, 'packages', 'articles', 'content', 'blog-meta-it.ts');
const TARGET = path.join(ROOT, 'tests', '__fixtures__', 'blog-meta-it-headline-check.ts');

/** Il cluster che i casi positivi devono trovare. */
const KEEP_RE = /salario-minimo/;

/**
 * Token delle headline «unrelated» dei casi negativi. Una voce che li contiene
 * trasformerebbe un caso negativo in un duplicato vero.
 */
const COLLIDE_RE = /valich|frontier|permess|trenord|sciopero|affitt|treni|code|lavori/i;

const SAMPLE_SIZE = 60;

const src = fs.readFileSync(SOURCE, 'utf8');
/** @type {Map<string, string[]>} */
const byId = new Map();
for (const line of src.split('\n')) {
  const id = (line.match(/'blog\.article\.([^.']+)\./) || [])[1];
  if (!id) continue;
  if (!byId.has(id)) byId.set(id, []);
  byId.get(id).push(line);
}

const ids = [...byId.keys()];
const kept = ids.filter((i) => KEEP_RE.test(i));
const sample = ids.filter((i) => !KEEP_RE.test(i) && !COLLIDE_RE.test(i)).slice(0, SAMPLE_SIZE);
const picked = [...kept, ...sample];
const body = picked.flatMap((i) => byId.get(i)).join('\n');

const header = fs.readFileSync(TARGET, 'utf8').split('const blogMetaIt')[0];
fs.writeFileSync(TARGET, `${header}const blogMetaIt: Record<string, string> = {\n${body}\n};\n\nexport default blogMetaIt;\n`);

console.log(`fixture rigenerata: ${picked.length} articoli (${kept.length} del cluster salario-minimo), ${body.split('\n').length} righe`);
console.log(`→ ${path.relative(ROOT, TARGET)}`);
