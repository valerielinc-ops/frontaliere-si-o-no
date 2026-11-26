import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  aggregateMarker,
  aggregateTitle,
  createCrawlerFamilyResolver,
  groupSharedFamilyIssues,
} from '../scripts/check-crawler-health.mjs';

/**
 * Una causa condivisa e' UNA issue. Il 23-26/11 cinque crawler Workday
 * (medtronic, eraneos, galderma, imerys, huntsman) hanno aperto una issue
 * ciascuno per lo stesso `abortKind=connection-level-fetch`, e il ciclo ha
 * lanciato un fixer per issue sugli stessi file della libreria.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKDAY_SLUGS = ['medtronic', 'eraneos', 'galderma', 'imerys', 'huntsman'];

function issue(slug: string, abortKind: string | null = 'connection-level-fetch', status = 'stale') {
  return {
    slug,
    status,
    abortKind,
    reason: abortKind
      ? `3 consecutive runs aborted before publishing a result (abortKind=${abortKind}) — ${slug}`
      : 'no fresh jobs',
  };
}

describe('famiglia ATS ricavata dal codice del repo', () => {
  it('assegna i cinque crawler Workday del 23-26/11 alla stessa famiglia', async () => {
    const resolve = await createCrawlerFamilyResolver();
    for (const slug of WORKDAY_SLUGS) {
      expect(await resolve(slug)).toEqual({
        family: 'workday',
        repairPoint: 'scripts/lib/ats-clients/workday-client.mjs',
      });
    }
  });

  it('non da una famiglia a un crawler che passa solo dall infrastruttura comune', async () => {
    const resolve = await createCrawlerFamilyResolver();
    expect(await resolve('a-plus-plus-group')).toBeNull();
    expect(await resolve('slug-che-non-esiste')).toBeNull();
  });
});

describe('aggregazione per famiglia e abortKind', () => {
  it('rigioca 5 crawler Workday con lo stesso abortKind: 1 aggregata, 0 singole', async () => {
    const resolve = await createCrawlerFamilyResolver();
    const { singles, aggregates } = await groupSharedFamilyIssues(
      WORKDAY_SLUGS.map((s) => issue(s)),
      resolve,
    );
    expect(singles).toEqual([]);
    expect(aggregates).toHaveLength(1);
    const [agg] = aggregates;
    expect(agg.title).toBe('[crawler-health] family:workday abortKind:connection-level-fetch');
    expect(agg.members).toEqual([...WORKDAY_SLUGS].sort());
    expect(agg.body).toContain(aggregateMarker('workday', 'connection-level-fetch'));
    expect(agg.body).toMatch(/^Repair point: `scripts\/lib\/ats-clients\/workday-client\.mjs`$/m);
    for (const slug of WORKDAY_SLUGS) expect(agg.body).toContain(`\`${slug}\``);
  });

  it('un crawler non Workday con lo stesso abortKind resta singolo', async () => {
    const resolve = await createCrawlerFamilyResolver();
    const { singles, aggregates } = await groupSharedFamilyIssues(
      [...WORKDAY_SLUGS.map((s) => issue(s)), issue('a-plus-plus-group')],
      resolve,
    );
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0].members).not.toContain('a-plus-plus-group');
    expect(singles.map((i) => i.slug)).toEqual(['a-plus-plus-group']);
  });

  it('un crawler Workday con un abortKind diverso resta singolo', async () => {
    const resolve = await createCrawlerFamilyResolver();
    const { singles, aggregates } = await groupSharedFamilyIssues(
      [
        ...WORKDAY_SLUGS.slice(0, 4).map((s) => issue(s)),
        issue('huntsman', 'retryable-http-response'),
      ],
      resolve,
    );
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0].members).toHaveLength(4);
    expect(singles.map((i) => i.slug)).toEqual(['huntsman']);
  });

  it('due soli crawler Workday con abortKind diversi non fanno gruppo', async () => {
    const resolve = await createCrawlerFamilyResolver();
    const { singles, aggregates } = await groupSharedFamilyIssues(
      [issue('medtronic'), issue('eraneos', 'retryable-http-response')],
      resolve,
    );
    expect(aggregates).toEqual([]);
    expect(singles).toHaveLength(2);
  });

  it('un solo crawler della famiglia resta singolo (soglia: 2 membri)', async () => {
    const resolve = await createCrawlerFamilyResolver();
    const { singles, aggregates } = await groupSharedFamilyIssues([issue('medtronic')], resolve);
    expect(aggregates).toEqual([]);
    expect(singles.map((i) => i.slug)).toEqual(['medtronic']);
  });

  it('non aggrega senza abortKind, advisory, summary-missing o Reason che non lo dichiara', async () => {
    const resolve = await createCrawlerFamilyResolver();
    const { aggregates } = await groupSharedFamilyIssues(
      [
        issue('medtronic', null),
        issue('eraneos', 'summary-missing'),
        issue('galderma', 'connection-level-fetch', 'advisory'),
        { ...issue('imerys'), reason: 'stale: no fresh jobs for 3 days' },
      ],
      resolve,
    );
    expect(aggregates).toEqual([]);
  });

  it('regge due giri consecutivi: stesso titolo e stesso marker, anche se il gruppo cambia', async () => {
    const resolve = await createCrawlerFamilyResolver();
    const round1 = await groupSharedFamilyIssues(WORKDAY_SLUGS.slice(0, 3).map((s) => issue(s)), resolve);
    const round2 = await groupSharedFamilyIssues(WORKDAY_SLUGS.map((s) => issue(s)), resolve);
    const round2b = await groupSharedFamilyIssues(WORKDAY_SLUGS.map((s) => issue(s)), resolve);
    // Il dedupe del creator e' sul titolo: il titolo non dipende dai membri.
    expect(round1.aggregates[0].title).toBe(round2.aggregates[0].title);
    expect(round1.aggregates[0].title).toBe(aggregateTitle('workday', 'connection-level-fetch'));
    expect(round1.aggregates[0].body).toContain(aggregateMarker('workday', 'connection-level-fetch'));
    expect(round2.aggregates[0].body).toContain(aggregateMarker('workday', 'connection-level-fetch'));
    // Rigiocare lo stesso giro produce lo stesso contenuto: niente commento diverso, niente nuova issue.
    expect(round2b.aggregates).toEqual(round2.aggregates);
  });

  it('lo stato broken di un membro alza lo stato dell aggregata', async () => {
    const resolve = await createCrawlerFamilyResolver();
    const { aggregates } = await groupSharedFamilyIssues(
      [issue('medtronic'), issue('eraneos', 'connection-level-fetch', 'broken')],
      resolve,
    );
    expect(aggregates[0].status).toBe('broken');
  });
});

describe('famiglie su un albero di script minimo', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-family-'));
    const lib = path.join(dir, 'lib');
    fs.mkdirSync(path.join(lib, 'ats-clients'), { recursive: true });
    for (const name of ['workday', 'lever']) {
      fs.writeFileSync(path.join(lib, 'ats-clients', `${name}-client.mjs`), 'export {};\n');
    }
    fs.writeFileSync(path.join(lib, 'wd-parser.mjs'), "import './ats-clients/workday-client.mjs';\n");
    fs.writeFileSync(
      path.join(lib, 'both-parser.mjs'),
      "import './ats-clients/workday-client.mjs';\nimport './ats-clients/lever-client.mjs';\n",
    );
    fs.writeFileSync(path.join(lib, 'template.mjs'), "import './ats-clients/lever-client.mjs';\n");
    fs.writeFileSync(path.join(dir, 'update-a-jobs.mjs'), "import './lib/wd-parser-a.mjs';\nimport './lib/template.mjs';\n");
    fs.writeFileSync(path.join(lib, 'wd-parser-a.mjs'), "import './ats-clients/workday-client.mjs';\n");
    fs.writeFileSync(path.join(lib, 'wd-parser-b.mjs'), "import './ats-clients/workday-client.mjs';\n");
    fs.writeFileSync(path.join(dir, 'update-b-jobs.mjs'), "import './lib/wd-parser-b.mjs';\nimport './lib/template.mjs';\n");
    fs.writeFileSync(path.join(dir, 'update-c-jobs.mjs'), "import './lib/template.mjs';\n");
    fs.writeFileSync(path.join(dir, 'update-d-jobs.mjs'), "import './lib/both-parser.mjs';\n");
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('taglia l infrastruttura condivisa e lascia ambigui i crawler a due famiglie', async () => {
    const resolve = await createCrawlerFamilyResolver({ scriptsDir: dir });
    expect((await resolve('a'))?.family).toBe('workday');
    expect((await resolve('b'))?.family).toBe('workday');
    // `template` e' importato da 3 script su 4: infrastruttura, non attraversata.
    expect(await resolve('c')).toBeNull();
    // raggiunge workday e lever: ambiguo, resta singolo.
    expect(await resolve('d')).toBeNull();
  });
});

describe('cablaggio del workflow', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/crawler-health-monitor.yml'),
    'utf8',
  );

  it('apre l aggregata dal titolo del file, chiude le singole non reclamate e salta quelle reclamate', () => {
    expect(workflow).toContain('.aggregate // false');
    expect(workflow).toContain('--description-file "$agg_body_file"');
    expect(workflow).toContain('index("agent:in-progress")) | not');
    expect(workflow).toContain('gh issue close "$dup" --reason "not planned"');
  });

  it('chiude l aggregata solo se il giro non la riemette, mai su un crash del monitor', () => {
    expect(workflow).toContain('HEALTH_OUTCOME: ${{ steps.health.outcome }}');
    expect(workflow).toContain('"[crawler-health] family:"*)');
    expect(workflow).toContain('.aggregate == true and .title == $t');
    expect(workflow).toContain('"${HEALTH_OUTCOME:-}" = "success"');
  });
});
