import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  JOBGATE_ARMS,
  JOBGATE_EXPERIMENT_ID,
  JOBGATE_RC_KEYS,
  getJobGateSubscriberVariant,
  getJobGateTelemetryParams,
  isJobGateNewsletterCta,
  jobGateNewsletterTags,
  parseJobGateWeights,
  pickJobGateArm,
  resolveJobGateAssignment,
  setActiveJobGateAssignment,
  validateJobGateWeights,
} from '@/services/jobGateExperiment';
import { jobGateSkin } from '@/components/community/jobGateSkin';
import { PUBLIC_CONFIG_KEYS } from '../functions/src/publicConfigKeys.js';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const syntheticIds = (n: number) => Array.from({ length: n }, (_, i) => `anon-${i.toString(36)}-${(i * 7919) % 104729}`);

function shareByArm(ids: string[], weights: Record<string, number>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of ids) {
    const arm = pickJobGateArm(id, weights);
    counts[arm] = (counts[arm] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).map(([arm, c]) => [arm, c / ids.length]));
}

describe('jobgate contract constants', () => {
  it('uses the experiment id and the three Remote Config keys agreed with the readout', () => {
    expect(JOBGATE_EXPERIMENT_ID).toBe('jobgate-v4');
    expect(JOBGATE_RC_KEYS).toEqual({
      enabled: 'JOBGATE_EXPERIMENT_ENABLED',
      arms: 'JOBGATE_EXPERIMENT_ARMS',
      force: 'JOBGATE_EXPERIMENT_FORCE',
    });
    expect(JOBGATE_ARMS[0]).toBe('control');
  });

  it('exposes the three keys to the browser through the public-config allowlist', () => {
    for (const key of Object.values(JOBGATE_RC_KEYS)) expect(PUBLIC_CONFIG_KEYS).toContain(key);
  });

  it('ships safe browser defaults: disabled, all control, nothing forced', () => {
    const src = read('services/firebase.ts');
    const defaults = src.slice(src.indexOf('const REMOTE_CONFIG_DEFAULTS'), src.indexOf('};', src.indexOf('const REMOTE_CONFIG_DEFAULTS')));
    expect(defaults).toContain("JOBGATE_EXPERIMENT_ENABLED: 'false',");
    expect(defaults).toContain(`JOBGATE_EXPERIMENT_ARMS: '{"control":100}',`);
    expect(defaults).toContain("JOBGATE_EXPERIMENT_FORCE: '',");
  });
});

describe('deterministic assignment', () => {
  const weights = { control: 25, navy_panel: 25, spotlight: 25, actions_first: 25 };

  it('gives the same visitor the same arm every time', () => {
    for (const id of syntheticIds(200)) {
      expect(pickJobGateArm(id, weights)).toBe(pickJobGateArm(id, weights));
    }
  });

  it('does not depend on the key order of the weights JSON', () => {
    const reordered = { actions_first: 25, spotlight: 25, navy_panel: 25, control: 25 };
    for (const id of syntheticIds(500)) expect(pickJobGateArm(id, reordered)).toBe(pickJobGateArm(id, weights));
  });

  it('salts the hash with the experiment id (independent of other splits)', () => {
    const ids = syntheticIds(2000);
    const same = ids.filter((id) => pickJobGateArm(id, weights, 'jobgate-v4') === pickJobGateArm(id, weights, 'other-exp')).length;
    // Independent 4-way splits agree ~25% of the time, not ~100%.
    expect(same / ids.length).toBeGreaterThan(0.2);
    expect(same / ids.length).toBeLessThan(0.3);
  });

  it('splits 10k synthetic visitors within ±2pp of 25/25/25/25', () => {
    const share = shareByArm(syntheticIds(10000), weights);
    for (const arm of JOBGATE_ARMS) expect(Math.abs((share[arm] ?? 0) - 0.25)).toBeLessThan(0.02);
  });

  it('splits 10k synthetic visitors within ±2pp of uneven weights 50/30/20/0', () => {
    const share = shareByArm(syntheticIds(10000), { control: 50, navy_panel: 30, spotlight: 20, actions_first: 0 });
    expect(Math.abs(share.control - 0.5)).toBeLessThan(0.02);
    expect(Math.abs(share.navy_panel - 0.3)).toBeLessThan(0.02);
    expect(Math.abs(share.spotlight - 0.2)).toBeLessThan(0.02);
    expect(share.actions_first ?? 0).toBe(0);
  });

  it('also stays within ±2pp on uuid-shaped ids (the production id format)', () => {
    const ids = Array.from({ length: 10000 }, (_, i) => {
      const hex = (i * 2654435761 >>> 0).toString(16).padStart(8, '0');
      return `anon-${hex}-${hex.slice(0, 4)}-4${hex.slice(1, 4)}-a${hex.slice(2, 5)}-${hex}${hex.slice(0, 4)}`;
    });
    const share = shareByArm(ids, weights);
    for (const arm of JOBGATE_ARMS) expect(Math.abs((share[arm] ?? 0) - 0.25)).toBeLessThan(0.02);
  });
});

describe('weights parsing', () => {
  it.each([
    ['empty', ''],
    ['not JSON', '{control:50'],
    ['an array', '[25,25]'],
    ['null', 'null'],
    ['a number', '100'],
    ['a negative weight', '{"control":50,"spotlight":-5}'],
    ['a fractional weight', '{"control":50.5,"spotlight":49.5}'],
    ['a string weight', '{"control":"50","spotlight":50}'],
    ['an unknown arm', '{"control":50,"apply_now":50}'],
    ['all zero', '{"control":0,"spotlight":0}'],
    ['an absurd weight', '{"control":1000000}'],
  ])('falls back to all-control on %s', (_label, raw) => {
    const result = validateJobGateWeights(raw);
    expect(result.valid).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
    expect(parseJobGateWeights(raw)).toEqual({ control: 100 });
  });

  it('accepts a valid weights object', () => {
    expect(validateJobGateWeights('{"control":25,"navy_panel":25,"spotlight":25,"actions_first":25}')).toEqual({
      valid: true,
      problems: [],
      weights: { control: 25, navy_panel: 25, spotlight: 25, actions_first: 25 },
    });
  });

  it('puts every visitor in control when the weights are invalid but the experiment is on', () => {
    for (const id of syntheticIds(300)) {
      expect(resolveJobGateAssignment({ enabled: 'true', arms: '{"nope":1}', force: '', visitorId: id })).toEqual({
        ready: true,
        enrolled: true,
        arm: 'control',
      });
    }
  });
});

describe('kill switch, force and fallbacks', () => {
  const arms = '{"control":25,"navy_panel":25,"spotlight":25,"actions_first":25}';

  it.each(['false', '', 'FALSE', '0', 'yes', undefined])('keeps everybody out when ENABLED=%s', (enabled) => {
    for (const id of syntheticIds(100)) {
      expect(resolveJobGateAssignment({ enabled, arms, force: 'spotlight', visitorId: id })).toEqual({
        ready: true,
        enrolled: false,
        arm: 'control',
      });
    }
  });

  it('accepts ENABLED with surrounding whitespace / upper case', () => {
    expect(resolveJobGateAssignment({ enabled: ' TRUE ', arms, force: '', visitorId: 'anon-x' }).enrolled).toBe(true);
  });

  it('forces a valid arm for every visitor, even without a visitor id', () => {
    for (const id of [...syntheticIds(100), null, '']) {
      expect(resolveJobGateAssignment({ enabled: 'true', arms, force: ' Actions_First ', visitorId: id })).toEqual({
        ready: true,
        enrolled: true,
        arm: 'actions_first',
      });
    }
  });

  it('ignores an invalid force and falls back to the weighted split', () => {
    const ids = syntheticIds(400);
    const arms4 = new Set(ids.map((id) => resolveJobGateAssignment({ enabled: 'true', arms, force: 'apply_now', visitorId: id }).arm));
    expect(arms4).toEqual(new Set<string>(JOBGATE_ARMS));
  });

  it('leaves a visitor without a stable id out of the experiment', () => {
    expect(resolveJobGateAssignment({ enabled: 'true', arms, force: '', visitorId: null })).toEqual({
      ready: true,
      enrolled: false,
      arm: 'control',
    });
  });
});

describe('telemetry and subscriber tags', () => {
  afterEach(() => setActiveJobGateAssignment(null));

  it('tags nothing while no visitor is enrolled', () => {
    setActiveJobGateAssignment({ ready: true, enrolled: false, arm: 'control' });
    expect(getJobGateTelemetryParams()).toBeNull();
    expect(getJobGateSubscriberVariant()).toBeNull();
    expect(jobGateNewsletterTags('job_gate_google_unlock')).toEqual({});
  });

  it('tags the gate subscribe event and the subscriber document for an enrolled visitor', () => {
    setActiveJobGateAssignment({ ready: true, enrolled: true, arm: 'navy_panel' });
    expect(getJobGateTelemetryParams()).toEqual({ experiment_id: 'jobgate-v4', variant: 'navy_panel' });
    expect(getJobGateSubscriberVariant()).toBe('jobgate-v4:navy_panel');
    expect(jobGateNewsletterTags('job_board_email_unlock')).toEqual({ experiment_id: 'jobgate-v4', variant: 'navy_panel' });
    // Other job_gate-channel surfaces do not render the experiment UI.
    for (const cta of ['job_expired_email_unlock', 'job_orphan_email_unlock', 'job_bridge_email_unlock', 'saved_jobs_alert_nudge']) {
      expect(jobGateNewsletterTags(cta)).toEqual({});
    }
  });

  it('matches every newsletter subscribe CTA the JobBoard gate emits', () => {
    const src = read('components/community/JobBoard.tsx');
    const ctas = [...src.matchAll(/trackNewsletter\('subscribe'[\s\S]{0,200}?sourceCta: (['`])([^'`]+)\1/g)].map((m) => m[2]);
    expect(ctas.length).toBeGreaterThanOrEqual(4);
    for (const cta of ctas) {
      const concrete = cta.replace('${provider}', 'facebook');
      expect(isJobGateNewsletterCta(concrete), concrete).toBe(true);
    }
  });

  it('adds the tags to the `newsletter` event in Analytics.trackNewsletter', () => {
    const src = read('services/analytics.ts');
    const body = src.slice(src.indexOf('trackNewsletter: ('), src.indexOf('trackNewsletterEvent: ('));
    expect(body).toMatch(/log\('newsletter', \{[\s\S]*?\.\.\.jobGateNewsletterTags\(context\.sourceCta\),[\s\S]*?\}\);/);
  });

  it('every job_auth_funnel event in JobBoard carries the gate experiment id and variant', () => {
    const src = read('components/community/JobBoard.tsx');
    const calls: string[] = [];
    let from = 0;
    for (;;) {
      const at = src.indexOf('Analytics.trackJobAuthFunnel(', from);
      if (at < 0) break;
      let depth = 0;
      let end = at;
      for (let i = src.indexOf('(', at); i < src.length; i += 1) {
        if (src[i] === '(') depth += 1;
        if (src[i] === ')') depth -= 1;
        if (depth === 0) { end = i; break; }
      }
      calls.push(src.slice(at, end + 1));
      from = end;
    }
    expect(calls.length).toBeGreaterThanOrEqual(10);
    for (const call of calls) {
      const tagged = /experimentId: gateExperimentId/.test(call) && /variant: gateVariant/.test(call);
      expect(tagged || /\.\.\.jobGateFailTags/.test(call), call.slice(0, 120)).toBe(true);
    }
  });

  it('the gate subscriber write goes through the variant-aware writer', () => {
    const src = read('components/community/JobBoard.tsx');
    expect(src).toContain('await upsertJobGateSubscriber(firestore, {');
    expect(src).toMatch(/upsertNewsletterSubscriber\(db, \{ \.\.\.unifiedEmailConsentInput\(input\), variant \}\)/);
  });
});

describe('jobgate-v4 arms: visual treatment only', () => {
  it('runs the four arms of round 4, control first', () => {
    expect(JOBGATE_ARMS).toEqual(['control', 'navy_panel', 'spotlight', 'actions_first']);
  });

  it('keeps control on the exact classes and order the gate shipped with', () => {
    const control = jobGateSkin('control');
    expect(control.container).toBe('relative z-10 mt-3 scroll-mt-20 rounded-stripe border border-accent-border bg-accent-subtle p-4 sm:p-6');
    expect(control.headerBand).toBeNull();
    expect(control.actionsFirst).toBe(false);
    expect(control.previewFade).toBe(false);
    expect(control.emailSubmitDisabledWhenEmpty).toBe(true);
    expect(control.consentNotice).toBeNull();
    expect(control.linkedInButton).toContain('bg-brand-linkedin');
  });

  it('gives every challenger its own container and keeps the gate a single region', () => {
    const containers = JOBGATE_ARMS.map((arm) => jobGateSkin(arm).container);
    expect(new Set(containers).size).toBe(JOBGATE_ARMS.length);
    for (const c of containers) expect(c).toContain('scroll-mt-20');
  });

  it('changes one lever per challenger: panel colour, colour hierarchy, block order', () => {
    const navy = jobGateSkin('navy_panel');
    expect(navy.container).toContain('bg-navy-900');
    expect(navy.actionsFirst).toBe(false);
    expect(navy.emailSubmitDisabledWhenEmpty).toBe(true);
    // On the dark panel secondary text and the notice link are white-tinted, never grey or teal.
    expect(navy.subtitle).toContain('text-on-accent');
    expect(navy.consentNotice).toContain('[&_a]:text-on-accent');
    expect(navy.authError).toContain('text-on-accent');

    const spot = jobGateSkin('spotlight');
    expect(spot.container).toContain('bg-surface');
    expect(spot.previewFade).toBe(true);
    expect(spot.emailSubmitDisabledWhenEmpty).toBe(false);
    expect(spot.linkedInButton).not.toContain('bg-brand-linkedin');
    expect(spot.linkedInIcon).toBe('text-brand-linkedin');
    expect(spot.actionsFirst).toBe(false);

    const first = jobGateSkin('actions_first');
    expect(first.headerBand).toContain('bg-stripe-700');
    expect(first.heading).toContain('text-on-accent');
    expect(first.actionsFirst).toBe(true);
    expect(first.emailSubmitDisabledWhenEmpty).toBe(true);
  });

  it('uses no inline hex and no dark: colour classes', () => {
    for (const arm of JOBGATE_ARMS) {
      for (const value of Object.values(jobGateSkin(arm))) {
        if (typeof value !== 'string') continue;
        expect(value, arm).not.toMatch(/#[0-9a-f]{3,8}\b/i);
        expect(value, arm).not.toMatch(/(^|\s)dark:/);
      }
    }
  });

  it('JobBoard renders the gate through the skin and keeps the notice next to the buttons in actions_first', () => {
    const src = read('components/community/JobBoard.tsx');
    expect(src).toContain('const gateSkin = jobGateSkin(jobGate.arm);');
    expect(src).toMatch(/className=\{gateSkin\.container\}/);
    // No late arm flip: committing the gate while the arm is pending locks this session to today's gate.
    expect(src).toContain('ref={(el) => { if (el && !jobGate.ready) lockJobGateBeforeAssignment(); }}');
    const band = src.slice(src.indexOf('{gateSkin.headerBand ? ('), src.indexOf(') : (', src.indexOf('{gateSkin.headerBand ? (')));
    expect(band.indexOf('{gateActions}')).toBeLessThan(band.indexOf('{gateConsent}'));
    expect(band.indexOf('{gateConsent}')).toBeLessThan(band.indexOf('{gateExplanation}'));
  });

  it('does not re-test the longer teaser already dropped as authgate-model-v1', () => {
    expect(JOBGATE_ARMS).not.toContain('long_preview');
    expect(JOBGATE_ARMS).not.toContain('value_first');
  });

  it('drops the round-3 copy keys from all four locales (v4 changes no copy)', () => {
    for (const locale of ['it', 'en', 'de', 'fr']) {
      expect(read(`services/locales/${locale}-core.ts`), locale).not.toContain("'jobBoard.gate.v3.");
    }
  });
});

describe('scripts/experiments/jobgate-rc.mjs (pure parts, no network)', () => {
  it('defaults to a dry-run of the launch configuration', async () => {
    const { parseArgs, buildJobGateValues, JOBGATE_LAUNCH_ARMS } = await import('../scripts/experiments/jobgate-rc.mjs');
    const opts = parseArgs([]);
    expect(opts.apply).toBe(false);
    expect(buildJobGateValues(opts)).toEqual({
      JOBGATE_EXPERIMENT_ENABLED: 'true',
      JOBGATE_EXPERIMENT_ARMS: JSON.stringify(JSON.parse(JOBGATE_LAUNCH_ARMS)),
      JOBGATE_EXPERIMENT_FORCE: '',
    });
  });

  it('refuses weights the browser would read as all-control, and unknown forced arms', async () => {
    const { parseArgs, buildJobGateValues } = await import('../scripts/experiments/jobgate-rc.mjs');
    expect(() => buildJobGateValues(parseArgs(['--arms', '{"control":50,"apply_now":50}']))).toThrow(/unknown arm/);
    expect(() => buildJobGateValues(parseArgs(['--force-arm', 'apply_now']))).toThrow(/not a known arm/);
    expect(() => buildJobGateValues(parseArgs(['--enabled', 'maybe']))).toThrow(/true\|false/);
    expect(buildJobGateValues(parseArgs(['--kill'])).JOBGATE_EXPERIMENT_ENABLED).toBe('false');
  });

  it('stages only the three jobgate keys and keeps their conditional values', async () => {
    const { buildJobGateValues, parseArgs, stageJobGateValues } = await import('../scripts/experiments/jobgate-rc.mjs');
    const template = {
      parameters: {
        OTHER_KEY: { defaultValue: { value: 'untouched' } },
        JOBGATE_EXPERIMENT_ENABLED: { defaultValue: { value: 'false' }, conditionalValues: { qa: { value: 'true' } } },
        JOBGATE_EXPERIMENT_FORCE: { defaultValue: { value: '' } },
      },
    };
    const diff = stageJobGateValues(template, buildJobGateValues(parseArgs([])));
    expect(diff.map((d: { key: string; changed: boolean }) => [d.key, d.changed])).toEqual([
      ['JOBGATE_EXPERIMENT_ENABLED', true],
      ['JOBGATE_EXPERIMENT_ARMS', true],
      ['JOBGATE_EXPERIMENT_FORCE', false],
    ]);
    expect(template.parameters.OTHER_KEY).toEqual({ defaultValue: { value: 'untouched' } });
    expect(template.parameters.JOBGATE_EXPERIMENT_ENABLED).toMatchObject({
      defaultValue: { value: 'true' },
      conditionalValues: { qa: { value: 'true' } },
      valueType: 'STRING',
    });
  });

  it('publishes without force (etag-guarded) and only behind --apply', () => {
    const src = read('scripts/experiments/jobgate-rc.mjs')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/force:\s*true/);
    expect(src).toContain('rc.publishTemplate(validated)');
    expect(src).toMatch(/if \(!opts\.apply\) \{[\s\S]*?return;/);
    expect(src).toContain('rc.validateTemplate(template)');
  });
});
