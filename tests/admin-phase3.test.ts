import { describe, expect, it, vi } from 'vitest';
import { buildTodaySummary, formatTodayDate } from '@/components/admin/lib/adminToday';
import { csvText, datedExportFilename } from '@/components/admin/lib/csv';
import { pageCount, pageSlice } from '@/components/admin/lib/pagination';
import { describeCronForLocalDay, scheduledOccurrencesForLocalDay } from '@/services/adminCron';
import { adminTodayRunsPath, adminTodayRunsTruncationNotice, failedCrawlerRunCount, loadAdminTodayRuns, type AdminTodayRun } from '@/services/adminTodayRuns';
import { buildAdminPaletteIndex, filterAdminPaletteIndex, type AdminPaletteItem } from '@/components/admin/lib/adminPalette';
import { adminDataDevPlugin, adminDataPlugin } from '../build-plugins/adminDataPlugin';
import { buildAdminWorkflowSchedulePayload } from '../build-plugins/adminWorkflowSchedules';
import { handleAdminAuditLog } from '../functions/src/adminAuditLog.js';
import { sanitizeAdminAuditDetails } from '../functions/src/adminAudit.js';
import { handleAdminRemoteConfig, isRemoteConfigSecret, sanitizeRemoteConfigParameters } from '../functions/src/adminRemoteConfig.js';

describe('admin fase 3 pure contracts', () => {
  it('calcola il riepilogo anche quando il dataset opzionale è assente', () => {
    expect(formatTodayDate(new Date('2026-10-23T08:00:00.000Z'))).toBe('venerdì 23 ottobre');
    expect(buildTodaySummary({ planned: 3, completed: 1, running: 1, failed: 1 })).toBe('Oggi 3 esecuzioni previste: 1 completata, 1 in corso, 1 da verificare.');
    expect(buildTodaySummary({ planned: 8, completed: 3, running: 1, failed: 2, activeJobs: 14206, activeJobsDelta: 412 })).toBe('Oggi 8 esecuzioni previste: 3 completate, 1 in corso, 2 da verificare. Annunci attivi 14.206, +412 rispetto a ieri.');
    expect(buildTodaySummary({ planned: 3, completed: 0, running: 0, failed: 0, activeJobs: 42 })).toBe('Oggi 3 esecuzioni previste. Annunci attivi 42.');
    expect(buildTodaySummary({ planned: 3, completed: 1, running: 1, failed: 1, crawlerCount: 581, crawlerGroups: 24 })).toContain('581 crawler in 24 gruppi');
  });

  it('interpreta cron in UTC e restituisce le occorrenze del giorno civile Europe/Zurich', () => {
    const summer = scheduledOccurrencesForLocalDay('0 9 * * *', '2026-07-01');
    expect(summer).toHaveLength(1);
    expect(summer[0].toISOString()).toBe('2026-07-01T09:00:00.000Z');
    expect(describeCronForLocalDay('*/30 * * * *', '2026-03-29')).toHaveLength(46);
    expect(scheduledOccurrencesForLocalDay('0 0 1 * 1', '2026-06-01')).toHaveLength(1);
    expect(adminTodayRunsPath(new Date('2026-10-23T08:00:00.000Z'))).toMatch(/^\/actions\/runs\?created=%3E%3D.*&per_page=100&branch=main$/u);
  });

  it('pagina le run fino a coprire la finestra e segnala il tetto di sicurezza', async () => {
    const calls: string[] = [];
    const now = new Date('2026-10-23T08:00:00.000Z');
    const fetchImpl = vi.fn(async (_url: string, options: RequestInit) => {
      const requestBody = JSON.parse(String(options.body)) as { path: string };
      const page = Number(new URL(requestBody.path, 'https://admin.invalid').searchParams.get('page') || '1');
      calls.push(requestBody.path);
      const count = page < 3 ? 100 : 50;
      const runs = Array.from({ length: count }, (_, index) => ({
        id: page * 1000 + index + 1,
        path: '.github/workflows/crawler-group-1.yml',
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-10-23T07:00:00.000Z',
        run_started_at: '2026-10-23T07:01:00.000Z',
        updated_at: '2026-10-23T07:02:00.000Z',
      }));
      return new Response(JSON.stringify({ ok: true, data: { total_count: 250, workflow_runs: runs } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const result = await loadAdminTodayRuns({ getIdToken: async () => 'token' }, now);
      expect(result).toMatchObject({ truncated: false, totalFetched: 250 });
      expect(calls).toHaveLength(3);
      expect(calls[0]).not.toContain('&page=');
      expect(calls[1]).toContain('&page=2');
      expect(adminTodayRunsTruncationNotice(result)).toBeNull();

      fetchImpl.mockImplementation(async (_url: string, options: RequestInit) => {
        const requestBody = JSON.parse(String(options.body)) as { path: string };
        const page = Number(new URL(requestBody.path, 'https://admin.invalid').searchParams.get('page') || '1');
        calls.push(requestBody.path);
        const runs = Array.from({ length: 100 }, (_, index) => ({
          id: page * 1000 + index + 1,
          path: '.github/workflows/crawler-group-1.yml',
          status: 'completed',
          conclusion: 'success',
          created_at: '2026-10-23T07:00:00.000Z',
          run_started_at: '2026-10-23T07:01:00.000Z',
          updated_at: '2026-10-23T07:02:00.000Z',
        }));
        return new Response(JSON.stringify({ ok: true, data: { total_count: 1201, workflow_runs: runs } }), { status: 200 });
      });
      calls.length = 0;
      const capped = await loadAdminTodayRuns({ getIdToken: async () => 'token' }, now);
      expect(capped).toMatchObject({ truncated: true, totalFetched: 1000 });
      expect(calls).toHaveLength(10);
      expect(adminTodayRunsTruncationNotice(capped)).toBe('Esecuzioni troncate: mostrate le più recenti 1000.');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('indicizza una volta le categorie grandi e limita aziende e crawler a 8 risultati', () => {
    const companies: AdminPaletteItem[] = Array.from({ length: 5_000 }, (_, index) => ({
      id: `company-${index}`,
      label: `Azienda sintetica ${index}`,
      kind: 'company',
      group: 'aziende',
    }));
    const index = buildAdminPaletteIndex(companies);
    const firstQuery = filterAdminPaletteIndex(index, 'azienda');
    const secondQuery = filterAdminPaletteIndex(index, 'sintetica 49');
    const shortQuery = filterAdminPaletteIndex(index, 'a');
    expect(index.large).toHaveLength(5_000);
    expect(firstQuery).toHaveLength(8);
    expect(secondQuery).toHaveLength(8);
    expect(shortQuery).toHaveLength(0);
    expect(firstQuery.every((item) => item.kind === 'company')).toBe(true);
  });

  it('mantiene il plugin dei dati admin attivo anche in dev per registrare il middleware JSON', () => {
    const buildPlugin = adminDataPlugin(process.cwd());
    expect(buildPlugin.apply).toBe('build');
    expect(buildPlugin.enforce).toBe('post');
    expect(buildPlugin.configureServer).toBeUndefined();
    expect(typeof buildPlugin.closeBundle).toBe('function');

    const devPlugin = adminDataDevPlugin(process.cwd());
    expect(devPlugin.apply).toBe('serve');
    expect(devPlugin.enforce).toBeUndefined();
    expect(devPlugin.closeBundle).toBeUndefined();
    expect(typeof devPlugin.configureServer).toBe('function');
    if (typeof devPlugin.configureServer === 'function') {
      type DevRequest = { url?: string };
      type DevResponse = { setHeader: (name: string, value: string) => void; end: (chunk?: string) => void };
      type DevMiddleware = (request: DevRequest, response: DevResponse, next: () => void) => void;
      type DevServerContract = { middlewares: { use: (middleware: DevMiddleware) => void } };
      const registered: DevMiddleware[] = [];
      const configureServer = devPlugin.configureServer as (server: DevServerContract) => void;
      configureServer({
        middlewares: {
          use(middleware: DevMiddleware) {
            registered.push(middleware);
          },
        },
      });
      expect(registered).toHaveLength(1);

      const headers: Record<string, string> = {};
      let body = '';
      const request: DevRequest = { url: '/data/admin-workflow-schedules.json' };
      const response = {
        setHeader(name: string, value: string) {
          headers[name] = value;
        },
        end(chunk?: string) {
          body = chunk || '';
        },
      };
      const next = vi.fn();
      registered[0](request, response, next);
      expect(next).not.toHaveBeenCalled();
      expect(headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(body)).toEqual(expect.objectContaining({ timezone: 'Europe/Zurich', workflows: expect.any(Array) }));
    }
  });

  it('conta solo i gruppi crawler falliti nella giornata locale', () => {
    const runs: AdminTodayRun[] = [
      { id: 1, workflowId: 'crawler-group-1.yml', status: 'completed', conclusion: 'failure', event: 'schedule', createdAt: '2026-10-23T05:00:00.000Z', startedAt: '2026-10-23T05:01:00.000Z', updatedAt: '2026-10-23T05:02:00.000Z', htmlUrl: null },
      { id: 2, workflowId: 'crawler-group-1.yml', status: 'completed', conclusion: 'failure', event: 'workflow_dispatch', createdAt: '2026-10-23T07:00:00.000Z', startedAt: '2026-10-23T07:01:00.000Z', updatedAt: '2026-10-23T07:02:00.000Z', htmlUrl: null },
      { id: 3, workflowId: 'generate-article.yml', status: 'completed', conclusion: 'failure', event: 'schedule', createdAt: '2026-10-23T06:00:00.000Z', startedAt: '2026-10-23T06:01:00.000Z', updatedAt: '2026-10-23T06:02:00.000Z', htmlUrl: null },
    ];
    expect(failedCrawlerRunCount(runs, '2026-10-23')).toBe(1);
  });

  it('emette solo le schedule dei workflow conosciuti dal pannello', () => {
    const payload = buildAdminWorkflowSchedulePayload(process.cwd(), new Date('2026-10-23T08:00:00.000Z'));
    const ids = payload.workflows.map((workflow) => workflow.id);
    expect(ids).toEqual(expect.arrayContaining(['analytics.yml', 'send-newsletter.yml', 'orchestrate-crawlers.yml']));
    expect(ids).not.toContain('ga4-error-monitor.yml');
    expect(payload.timezone).toBe('Europe/Zurich');
  });

  it('mantiene escaping CSV, CRLF, BOM filename e paginazione da 50', () => {
    expect(csvText(['Nome', 'Nota'], [['A, "uno"', 'riga 1\nriga 2']])).toBe('Nome,Nota\r\n"A, ""uno""","riga 1\nriga 2"');
    expect(datedExportFilename('crawler', new Date('2026-10-22T23:30:00.000Z'))).toBe('crawler-2026-10-23.csv');
    expect(pageCount(101)).toBe(3);
    expect(pageSlice(Array.from({ length: 101 }, (_, index) => index), 3)).toEqual([100]);
  });

  it('nasconde i dettagli sensibili dell’audit', () => {
    const details = sanitizeAdminAuditDetails({ changedFields: ['name'], email: 'owner@example.test', body: 'CV completo', token: 'secret', safe: 'ok' });
    expect(details).toEqual({ changedFields: ['name'], safe: 'ok' });
  });

  it('paga il registro a 50, filtra per data inclusiva e non serializza email/testo', async () => {
    const documents = [
      { id: 'new', data: () => ({ at: new Date('2026-10-23T23:59:59.000Z'), uid: 'owner', action: 'profile_update', target: 'marco', email: 'owner@example.test', details: { safe: 'yes', body: 'CV' } }) },
      ...Array.from({ length: 51 }, (_, index) => ({ id: `old-${index}`, data: () => ({ at: new Date('2026-10-22T12:00:00.000Z'), uid: 'owner', action: 'workflow_dispatch', target: `workflow-${index}`, details: {} }) })),
    ];
    const query = {
      where: vi.fn(() => query),
      orderBy: vi.fn(() => query),
      startAfter: vi.fn(() => query),
      limit: vi.fn(() => query),
      get: vi.fn(async () => ({ docs: documents })),
    };
    const result = await handleAdminAuditLog({ method: 'GET', query: { from: '2026-10-23', to: '2026-10-23' } }, {
      assertSiteAdmin: async () => ({ ok: true, uid: 'owner' }),
      db: { collection: () => query },
    });
    expect(result.status).toBe(200);
    expect(result.body.entries).toHaveLength(1);
    expect(result.body.entries[0]).not.toHaveProperty('email');
    expect(result.body.entries[0].details).toEqual({ safe: 'yes' });
  });

  it('riduce i parametri Remote Config segreti a nome e valore nascosto', async () => {
    expect(isRemoteConfigSecret('PUBLIC_FLAG', { defaultValue: { value: 'true' } })).toBe(false);
    expect(isRemoteConfigSecret('GITHUB_PAT', { defaultValue: { value: 'not-returned' } })).toBe(true);
    expect(isRemoteConfigSecret('control', { defaultValue: { value: 'control' } })).toBe(false);
    const sanitized = sanitizeRemoteConfigParameters({ parameters: {
      SMTP_PASS: { defaultValue: { value: 'smtp-password' } },
      harmless_long: { defaultValue: { value: 'abcd1234efgh5678ijkl9012' } },
      json_value: { defaultValue: { value: '{"token":"x"}' } },
      url_value: { defaultValue: { value: 'https://user:pass@example.com' } },
      list_value: { defaultValue: { value: ' jobs, blog ' } },
      bool_value: { defaultValue: { value: ' true ' } },
      number_value: { defaultValue: { value: '42' } },
      variant_value: { defaultValue: { value: 'control' } },
      conditional_value: { defaultValue: { value: 'control' }, conditionalValues: { production: { value: 'https://secret.example' } } },
      safe_description: { defaultValue: { value: 'yes' }, description: 'Configurazione breve' },
      unsafe_description: { defaultValue: { value: 'yes' }, description: 'Consulta https://example.com per i dettagli' },
    } });
    expect(sanitized.find((parameter) => parameter.name === 'SMTP_PASS')).toEqual({ name: 'SMTP_PASS', hidden: true, reason: 'nome sensibile' });
    expect(sanitized.find((parameter) => parameter.name === 'harmless_long')).toEqual({ name: 'harmless_long', hidden: true, reason: 'non è un flag' });
    expect(sanitized.find((parameter) => parameter.name === 'json_value')).toEqual({ name: 'json_value', hidden: true, reason: 'non è un flag' });
    expect(sanitized.find((parameter) => parameter.name === 'url_value')).toEqual({ name: 'url_value', hidden: true, reason: 'non è un flag' });
    expect(sanitized.find((parameter) => parameter.name === 'conditional_value')).toEqual({ name: 'conditional_value', hidden: true, reason: 'non è un flag' });
    expect(sanitized.find((parameter) => parameter.name === 'list_value')).toEqual({ name: 'list_value', defaultValue: 'jobs,blog', conditionalValues: [], description: '' });
    expect(sanitized.find((parameter) => parameter.name === 'bool_value')).toEqual({ name: 'bool_value', defaultValue: 'true', conditionalValues: [], description: '' });
    expect(sanitized.find((parameter) => parameter.name === 'number_value')).toEqual({ name: 'number_value', defaultValue: '42', conditionalValues: [], description: '' });
    expect(sanitized.find((parameter) => parameter.name === 'variant_value')).toEqual({ name: 'variant_value', defaultValue: 'control', conditionalValues: [], description: '' });
    expect(sanitized.find((parameter) => parameter.name === 'safe_description')).toEqual({ name: 'safe_description', defaultValue: 'yes', conditionalValues: [], description: 'Configurazione breve' });
    expect(sanitized.find((parameter) => parameter.name === 'unsafe_description')).toEqual({ name: 'unsafe_description', defaultValue: 'yes', conditionalValues: [], description: '' });
    expect(JSON.stringify(sanitized)).not.toContain('smtp-password');
    expect(JSON.stringify(sanitized)).not.toContain('https://secret.example');
    expect(JSON.stringify(sanitized)).not.toContain('user:pass@example.com');
    const result = await handleAdminRemoteConfig({ method: 'GET' }, { assertSiteAdmin: async () => ({ ok: true }), getTemplate: async () => ({ parameters: { API_KEY: { defaultValue: { value: 'secret' } } } }) });
    expect(result).toEqual({ status: 200, body: { ok: true, parameters: [{ name: 'API_KEY', hidden: true, reason: 'nome sensibile' }] } });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('applica il gate admin anche alle nuove letture audit e Remote Config', async () => {
    const assertSiteAdmin = async () => ({ ok: false, status: 403, error: 'not_admin' });
    const audit = await handleAdminAuditLog({ method: 'GET' }, { assertSiteAdmin, db: { collection: vi.fn() } });
    const remoteConfig = await handleAdminRemoteConfig({ method: 'GET' }, { assertSiteAdmin, getTemplate: vi.fn() });
    expect(audit).toEqual({ status: 403, body: { ok: false, error: 'not_admin' } });
    expect(remoteConfig).toEqual({ status: 403, body: { ok: false, error: 'not_admin' } });
  });
});
