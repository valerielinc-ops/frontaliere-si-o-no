/**
 * Only the source's own text is published (issue 5253, lot P part 2 — the
 * "fallbackDesc" class, parsers whose stand-in no stored row carries today):
 * when a posting had no body, or one under a local character/word threshold,
 * these parsers published a stand-in they wrote themselves — "<title> —
 * <company>, <place>", "<title> — Stelle bei … + company paragraph",
 * "<title> — open position at …", "<company> — Stelle in <city>". Now a body
 * under the common 50-word floor gives no description: the shared pipeline
 * keeps the body stored from an earlier read of the source (the
 * locale-preserving merge) or quarantines the posting (thin-source path), and
 * the posting keeps its slug.
 *
 * The parsers build the description inside their fetch loop (network,
 * Playwright): guard the removed stand-in and the shared floor on the body.
 * cseb and amstein-walthert assert the behaviour in their own tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = (file: string) => fs.readFileSync(path.join(__dirname, '..', 'scripts', ...file.split('/')), 'utf8');

describe('no crawler-written stand-in, and the common 50-word floor', () => {
  it.each([
    ['lib/amina-bank-job-parser.mjs', /fallbackDesc|`\$\{title\} — posizione presso AMINA Bank|pioniera nei servizi finanziari/],
    ['lib/amstein-walthert-job-parser.mjs', /fallbackDesc|MIN_DESC_LENGTH|konsultieren Sie bitte die offizielle Stellenausschreibung/],
    ['lib/bitfinex-job-parser.mjs', /fallbackDesc|open position at Bitfinex/],
    ['lib/cseb-job-parser.mjs', /fallbackDesc|— Center da Sanadad Engiadina Bassa, \$\{/],
    ['lib/fhgr-job-parser.mjs', /fallbackDesc|— Fachhochschule Graubünden, \$\{/],
    ['lib/hochgebirgsklinik-davos-job-parser.mjs', /fallbackDesc|— Hochgebirgsklinik Davos, \$\{/],
    ['lib/inselspital-job-parser.mjs', /fallbackDesc|— Inselspital Bern, Bern`/],
    ['lib/ksw-job-parser.mjs', /fallbackDesc|— \$\{KSW_COMPANY_NAME\}, Winterthur/],
    ['lib/lalive-job-parser.mjs', /fallbackDesc|Offerta di lavoro presso LALIVE/],
    ['lib/ostendis-publication-common.mjs', /fallbackDescription|defaultFallback|— Stelle in \$\{defaultCity\}/],
    ['lib/salina-reha-job-parser.mjs', /fallbackDesc|Stelle in der Salina Rehaklinik/],
    ['lib/see-spital-job-parser.mjs', /fallbackDesc|— \$\{SEE_SPITAL_COMPANY_NAME\}, /],
    ['lib/spital-davos-job-parser.mjs', /fallbackDesc|— Spital Davos, Davos/],
    ['lib/spital-maennedorf-job-parser.mjs', /fallbackDesc|— \$\{SPITAL_MAENNEDORF_COMPANY_NAME\}, /],
    ['lib/straumann-job-parser.mjs', /fallbackDesc|— \$\{STRAUMANN_COMPANY_NAME\}, /],
    ['lib/sune-egge-job-parser.mjs', /fallbackDesc|Stelle im Fachspital Sune-Egge in/],
    ['lib/tschuggen-job-parser.mjs', /fallbackDesc|— Tschuggen Collection, \$\{/],
    ['lib/villa-im-park-job-parser.mjs', /fallbackDesc|Stelle in der Privatklinik Villa im Park in/],
  ])('%s', (file, pattern) => {
    const text = source(file);
    expect(text).not.toMatch(pattern);
    expect(text).toMatch(/meetsSourceBodyFloor\(/);
  });

  it('tl-lausanne no longer swaps a thin body for a French text of its own', () => {
    // The factory marker it looked for is gone from the shared SuccessFactors
    // factory, which now leaves a thin body empty; the rewrite was dead code.
    const text = source('lib/tl-lausanne-job-parser.mjs');
    expect(text).not.toMatch(/localizedFallbackDescription|FACTORY_FALLBACK_MARKER|est l'entreprise de transports publics/);
    expect(source('lib/successfactors-shared-job-parser-common.mjs')).not.toMatch(/ist ein etablierter Schweizer Gesundheitsdienstleister/);
  });
});
