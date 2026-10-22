import { describe, expect, it } from 'vitest';
import {
  buildAlertEmail,
} from '../scripts/send-job-alerts.mjs';
import {
  JOB_ALERT_SUBJECT_EXPERIMENT_ID,
  JOB_ALERT_SUBJECT_VARIANTS,
  assignJobAlertSubjectVariant,
  jobAlertSubjectPeriodId,
  readJobAlertSubjectConfig,
  renderJobAlertSubject,
} from '../scripts/lib/job-alert-subject-experiment.mjs';

const alert = {
  id: 'subject-test-alert',
  email: 'seeker@example.com',
  locale: 'it',
  keywords: ['amministrazione'],
  locations: ['Lugano'],
  sectors: [],
};

const job = (overrides: Record<string, unknown> = {}) => ({
  title: 'Assistente amministrativo',
  titleByLocale: {
    it: 'Assistente amministrativo',
    en: 'Administrative assistant',
    de: 'Administrative Assistenz',
    fr: 'Assistant administratif',
  },
  company: 'Azienda Esempio',
  location: 'Lugano',
  slug: 'assistente-amministrativo',
  slugByLocale: {},
  firstSeenAt: new Date().toISOString(),
  ...overrides,
});

describe('job-alert subject experiment', () => {
  it('has the four planned arms and a safe disabled default', () => {
    expect(JOB_ALERT_SUBJECT_VARIANTS.map(({ id }) => id)).toEqual([
      'control',
      'match',
      'novita',
      'scoperta',
    ]);
    expect(readJobAlertSubjectConfig({} as NodeJS.ProcessEnv)).toMatchObject({
      experimentId: JOB_ALERT_SUBJECT_EXPERIMENT_ID,
      enabled: false,
      rollout: 0,
      variantIds: ['control'],
    });
  });

  it('requires the Remote Config assignment to name all four arms', () => {
    const safeConfig = readJobAlertSubjectConfig({
      JOB_ALERT_SUBJECT_AB_ENABLED: 'true',
      JOB_ALERT_SUBJECT_AB_ROLLOUT: '1',
    } as NodeJS.ProcessEnv);
    expect(assignJobAlertSubjectVariant({
      email: 'missing-assignment@example.com',
      alertId: 'alert-1',
      periodId: 'week-test',
      config: safeConfig,
    })).toMatchObject({ variant: 'control', inExperiment: false });

    const configured = readJobAlertSubjectConfig({
      JOB_ALERT_SUBJECT_AB_ENABLED: 'true',
      JOB_ALERT_SUBJECT_AB_ROLLOUT: '1',
      JOB_ALERT_SUBJECT_AB_VARIANTS: 'control,match,novita,scoperta',
    } as NodeJS.ProcessEnv);
    expect(configured.variantIds).toEqual(['control', 'match', 'novita', 'scoperta']);
    expect(assignJobAlertSubjectVariant({
      email: 'configured@example.com',
      alertId: 'alert-1',
      periodId: 'week-test',
      config: configured,
    }).inExperiment).toBe(true);

    const jsonConfigured = readJobAlertSubjectConfig({
      JOB_ALERT_SUBJECT_AB_VARIANTS: '["control","match","novita","scoperta"]',
    } as NodeJS.ProcessEnv);
    expect(jsonConfigured.variantIds).toEqual(['control', 'match', 'novita', 'scoperta']);
  });

  it('keeps the same arm across retries and normalizes the email', () => {
    const config = { enabled: true, rollout: 1, seed: 'test-seed', experimentId: JOB_ALERT_SUBJECT_EXPERIMENT_ID };
    const first = assignJobAlertSubjectVariant({
      email: 'Seeker@Example.com',
      alertId: 'alert-1',
      periodId: 'week-test',
      config,
    });
    const retry = assignJobAlertSubjectVariant({
      email: ' seeker@example.com ',
      alertId: 'alert-1',
      periodId: 'week-test',
      config,
    });
    expect(retry).toMatchObject({ variant: first.variant, inExperiment: true });
  });

  it('distributes enabled traffic over all four arms and keeps rollout holdback out', () => {
    const config = { enabled: true, rollout: 1, seed: 'distribution-seed', experimentId: JOB_ALERT_SUBJECT_EXPERIMENT_ID };
    const ids = new Set(
      Array.from({ length: 500 }, (_, index) => assignJobAlertSubjectVariant({
        email: `user-${index}@example.com`,
        alertId: 'alert-1',
        periodId: 'week-test',
        config,
      }).variant),
    );
    expect(ids).toEqual(new Set(['control', 'match', 'novita', 'scoperta']));

    const holdback = assignJobAlertSubjectVariant({
      email: 'holdback@example.com',
      alertId: 'alert-1',
      periodId: 'week-test',
      config: { ...config, rollout: 0 },
    });
    expect(holdback).toMatchObject({ variant: 'control', inExperiment: false });
  });

  it('uses a UTC week key so both daily slots share the same period', () => {
    const monday = new Date();
    monday.setUTCHours(0, 0, 0, 0);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const thursday = new Date(monday.getTime() + 3 * 24 * 60 * 60 * 1000);
    const sunday = new Date(monday.getTime() + 6 * 24 * 60 * 60 * 1000);
    expect(jobAlertSubjectPeriodId(thursday)).toBe(jobAlertSubjectPeriodId(monday));
    expect(jobAlertSubjectPeriodId(sunday)).toBe(jobAlertSubjectPeriodId(monday));
  });

  it('changes only the subject, not the email body', () => {
    const jobs = [job(), job({ title: 'Contabile', titleByLocale: { it: 'Contabile' } })];
    const control = buildAlertEmail(alert, jobs, true);
    const treatment = buildAlertEmail(alert, jobs, true, null, {
      variant: 'match',
      inExperiment: true,
      experimentId: JOB_ALERT_SUBJECT_EXPERIMENT_ID,
      periodId: 'week-test',
    });

    expect(control.subject).toBe('🔔 Assistente amministrativo presso Azienda Esempio (+1 altre offerte)');
    expect(treatment.subject).toContain('🎯 2 offerte per amministrazione a Lugano');
    expect(treatment.subject.length).toBeLessThanOrEqual(78);
    expect(treatment.html).toBe(control.html);
    expect(treatment.text).toBe(control.text);
  });

  it('does not make a false freshness claim for the novita arm', () => {
    const old = job({ firstSeenAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString() });
    const rendered = renderJobAlertSubject({
      variant: 'novita',
      locale: 'it',
      controlSubject: '🔔 Assistente amministrativo presso Azienda Esempio',
      shownCount: 1,
      keyword: 'amministrazione',
      locationLabel: 'Lugano',
      subjectLabel: 'amministrazione',
      useNewCopy: false,
    });
    expect(rendered.subject).toContain('offerta selezionata');
    expect(rendered.subject).not.toContain('nuova');
    expect(rendered.freshnessQualified).toBe(false);
    expect(old.firstSeenAt).toBeTruthy();
  });
});
