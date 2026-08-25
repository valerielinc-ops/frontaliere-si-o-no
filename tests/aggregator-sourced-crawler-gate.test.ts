import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { scanJobParsers } from '../scripts/lib/aggregator-source-gate.mjs';

/**
 * Guards the failure mode behind frontaliereticino.ch/cerca-lavoro-ticino
 * job pages whose `url`/`applyUrl` sends the visitor to a job-board
 * aggregator (jobs.ch, jobup.ch, ...) instead of the employer directly: the
 * job data can be perfectly genuine while the DESTINATION we publish is
 * still wrong, and no other test catches that because the other quality
 * gates only judge whether the data is real, not where it links.
 *
 * See `scripts/lib/aggregator-source-gate.mjs` for the tag contract.
 */
const LIB_DIR = path.resolve(__dirname, '..', 'scripts', 'lib');

describe('dedicated crawlers sourced from a known job-board aggregator', () => {
  const findings = scanJobParsers(LIB_DIR);

  it('the scanner itself finds the known aggregator-backed parsers (sanity check)', () => {
    expect(findings.map((f) => f.file)).toContain('equans-job-parser.mjs');
  });

  it.each(findings.map((f) => [f.file, f]))(
    '%s declares an @outsourced-ats-* tag with evidence',
    (_file, f) => {
      expect(
        f.tag,
        `${f.file} imports ${f.clients.join(', ')} (a known aggregator-backed client, ` +
          'see scripts/lib/known-aggregator-domains.mjs) but has no @outsourced-ats-* tag. ' +
          "Either crawl the employer's own domain directly, or document why not: " +
          '@outsourced-ats-confirmed / @outsourced-ats-needs-migration / @outsourced-ats-needs-verification.',
      ).not.toBeNull();
      expect(f.tag.evidence.length, `${f.file}: @outsourced-ats-${f.tag?.tag} tag has no real evidence text`).toBeGreaterThan(10);
    },
  );
});
