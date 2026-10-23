import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Copy, Database, Loader2, RefreshCw, Shield, Terminal, ToggleLeft, ToggleRight } from 'lucide-react';
import { useAuth } from '@/services/authService';
import { AdminMessageBanner, type AdminMessage } from '@/components/admin/ui/AdminMessageBanner';
import { useAdminWorkflow, AdminWorkflowDispatchError } from '@/components/admin/AdminWorkflowProvider';
import type { JobsCrawlerConfigMeta, JobsCrawlerConfigState } from '@/components/admin/lib/adminTypes';
import {
  ADMIN_JOBS_CRAWLER_CONFIG_ENDPOINT,
  DEFAULT_JOBS_CRAWLER_CONFIG,
  JOBS_CRAWLER_CONFIG_LIMITS,
  adminFunctionError,
  buildCrawlerConfigPayload,
  crawlerFormSignature,
  mapCrawlerConfig,
  normalizeHost,
  normalizeSeedMap,
  parseJsonObject,
  parseListInput,
} from '@/components/admin/lib/jobsCrawlerConfig';

const emptyConfig = (): JobsCrawlerConfigState => ({ ...DEFAULT_JOBS_CRAWLER_CONFIG });
const CRAWLER_CONFIG_LIMITS = JOBS_CRAWLER_CONFIG_LIMITS;

export default function ConfigurazioneCrawlerSection() {
  const { user } = useAuth();
  const workflow = useAdminWorkflow();
  const [config, setConfig] = useState<JobsCrawlerConfigState>(emptyConfig);
  const [domainWhitelistText, setDomainWhitelistText] = useState('');
  const [domainBlacklistText, setDomainBlacklistText] = useState('');
  const [companyPriorityByDomainText, setCompanyPriorityByDomainText] = useState('{}');
  const [companyPriorityByNameText, setCompanyPriorityByNameText] = useState('{}');
  const [sourceSeedsByDomainText, setSourceSeedsByDomainText] = useState('{}');
  const [sourceSeedsByNameText, setSourceSeedsByNameText] = useState('{}');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<AdminMessage | null>(null);
  const [meta, setMeta] = useState<JobsCrawlerConfigMeta>({ source: 'default', updatedAt: null, updatedBy: null });
  const [parserCompanyName, setParserCompanyName] = useState('');
  const [parserCompanyWebsite, setParserCompanyWebsite] = useState('');
  const [parserCompanyKey, setParserCompanyKey] = useState('');
  const [parserApplyConfig, setParserApplyConfig] = useState(false);
  const [parserLoading, setParserLoading] = useState(false);
  const [parserLocked, setParserLocked] = useState(false);
  const [parserMessage, setParserMessage] = useState<AdminMessage | null>(null);
  const loadedSignature = useRef('');

  const applyConfig = useCallback((next: JobsCrawlerConfigState) => {
    setConfig(next);
    setDomainWhitelistText(next.domainWhitelist.join('\n'));
    setDomainBlacklistText(next.domainBlacklist.join('\n'));
    setCompanyPriorityByDomainText(JSON.stringify(next.companyPriorityByDomain, null, 2));
    setCompanyPriorityByNameText(JSON.stringify(next.companyPriorityByName, null, 2));
    setSourceSeedsByDomainText(JSON.stringify(next.sourceSeedsByDomain, null, 2));
    setSourceSeedsByNameText(JSON.stringify(next.sourceSeedsByName, null, 2));
    loadedSignature.current = crawlerFormSignature(next);
  }, []);

  const formConfig = useMemo<JobsCrawlerConfigState | null>(() => {
    try {
      return {
        ...config,
        domainWhitelist: parseListInput(domainWhitelistText).map(normalizeHost).filter(Boolean),
        domainBlacklist: parseListInput(domainBlacklistText).map(normalizeHost).filter(Boolean),
        companyPriorityByDomain: parseJsonObject(companyPriorityByDomainText),
        companyPriorityByName: parseJsonObject(companyPriorityByNameText),
        sourceSeedsByDomain: normalizeSeedMap(parseJsonObject(sourceSeedsByDomainText)),
        sourceSeedsByName: normalizeSeedMap(parseJsonObject(sourceSeedsByNameText)),
      };
    } catch {
      return null;
    }
  }, [companyPriorityByDomainText, companyPriorityByNameText, config, domainBlacklistText, domainWhitelistText, sourceSeedsByDomainText, sourceSeedsByNameText]);
  const formConfigRef = useRef(formConfig);
  formConfigRef.current = formConfig;

  const loadConfig = useCallback(async (force = false) => {
    if (force && loadedSignature.current && loadedSignature.current !== (formConfigRef.current ? crawlerFormSignature(formConfigRef.current) : '') && typeof window !== 'undefined') {
      if (!window.confirm('Ricaricare la configurazione crawler? Le modifiche non salvate verranno perse.')) return;
    }
    setLoading(true);
    setMessage(null);
    try {
      if (!user) throw new Error('Devi essere autenticato come admin per caricare la configurazione crawler.');
      const token = await user.getIdToken();
      const response = await fetch(ADMIN_JOBS_CRAWLER_CONFIG_ENDPOINT, { headers: { Authorization: `Bearer ${token}` } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(adminFunctionError(data, response.status));
      applyConfig(mapCrawlerConfig(data.config || DEFAULT_JOBS_CRAWLER_CONFIG));
      setMeta({ source: data.source === 'firestore' ? 'firestore' : 'default', updatedAt: data.updatedAt ? String(data.updatedAt) : null, updatedBy: data.updatedBy ? String(data.updatedBy) : null });
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Errore caricamento configurazione crawler.' });
    } finally {
      setLoading(false);
    }
  }, [applyConfig, user]);

  useEffect(() => { void loadConfig(); }, [loadConfig]);

  const saveConfig = async () => {
    setSaving(true);
    setMessage(null);
    try {
      if (!formConfigRef.current) throw new Error('JSON non valido nei campi crawler.');
      const payload = buildCrawlerConfigPayload(formConfigRef.current);
      if (!user) throw new Error('Devi essere autenticato come admin per salvare la configurazione crawler.');
      const token = await user.getIdToken();
      const response = await fetch(ADMIN_JOBS_CRAWLER_CONFIG_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(adminFunctionError(data, response.status));
      const next = mapCrawlerConfig(data.config || payload);
      applyConfig(next);
      setMeta({ source: 'firestore', updatedAt: data.updatedAt ? String(data.updatedAt) : new Date().toISOString(), updatedBy: data.updatedBy ? String(data.updatedBy) : user.email || null });
      setMessage({ kind: 'ok', text: 'Configurazione salvata. Verrà applicata al prossimo avvio dell’orchestratore (09:00 e 21:00 UTC).' });
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Errore salvataggio configurazione crawler.' });
    } finally {
      setSaving(false);
    }
  };

  const runGenerateParser = async () => {
    if (parserLoading || parserLocked) return;
    const companyName = parserCompanyName.trim();
    const companyWebsite = parserCompanyWebsite.trim();
    if (!companyName || !companyWebsite) {
      setParserMessage({ kind: 'error', text: 'Inserisci nome azienda e URL sito prima di lanciare la generazione parser.' });
      return;
    }
    if (parserApplyConfig && typeof window !== 'undefined' && !window.confirm(`Generare il parser per ${companyName} e applicare la configurazione?\n\nImpatto: il workflow potrà modificare il catalogo crawler e la config azienda.\nInput: company=${companyName}, website=${companyWebsite}, apply_config=true\nDurata attesa: 5-20 min\n\nProcedere?`)) return;
    setParserLoading(true);
    setParserMessage(null);
    try {
      await workflow.dispatchWorkflow('generate-company-parser.yml', {
        company_name: companyName,
        company_website: companyWebsite,
        company_key: parserCompanyKey.trim(),
        apply_config: parserApplyConfig ? 'true' : 'false',
      });
      setParserMessage({ kind: 'ok', text: `Generazione parser avviata per "${companyName}" (${parserApplyConfig ? 'applica config: sì' : 'solo proposta'}).` });
    } catch (error) {
      const ambiguous = error instanceof AdminWorkflowDispatchError && error.ambiguous;
      if (ambiguous) setParserLocked(true);
      const detail = error instanceof Error ? error.message : 'Errore sconosciuto';
      setParserMessage({ kind: ambiguous ? 'warn' : 'error', text: ambiguous ? `Esito generazione parser da verificare in GitHub Actions: ${detail}` : `Generazione parser fallita: ${detail}` });
    } finally {
      setParserLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold font-display text-strong flex items-center gap-2"><Database size={20} className="text-accent" />Configurazione crawler</h2>
          <p className="text-sm text-muted mt-1">Soglie qualità, localizzazione AI, riuso traduzioni, domini e seed URL.</p>
        </div>
        <button type="button" onClick={() => void loadConfig(true)} disabled={loading} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-raised text-body text-sm font-medium disabled:opacity-60"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} />Ricarica</button>
      </div>
      {message && <AdminMessageBanner message={message} />}
      <p className="text-xs text-muted">Sorgente: <span className="font-semibold text-body">{meta.source === 'firestore' ? 'Firestore' : 'default'}</span>{' · '}Ultima modifica: <span className="font-semibold text-body">{meta.updatedAt ? new Date(meta.updatedAt).toLocaleString('it-CH') : 'mai registrata'}</span>{meta.updatedBy ? ` da ${meta.updatedBy}` : ''}</p>

      <div className="rounded-lg border border-edge bg-surface-alt/40 p-3 space-y-3">
        <div className="text-xs font-semibold text-body">Genera parser/crawler AI per nuova azienda</div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="text-sm text-subtle">Nome azienda<input value={parserCompanyName} onChange={(event) => setParserCompanyName(event.target.value)} placeholder="es. VF International" aria-label="Nome azienda" className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface text-strong" /></label>
          <label className="text-sm text-subtle">URL sito azienda<input type="url" value={parserCompanyWebsite} onChange={(event) => setParserCompanyWebsite(event.target.value)} placeholder="https://azienda.ch" aria-label="URL sito azienda" className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface text-strong" /></label>
          <label className="text-sm text-subtle">Company key (opzionale)<input value={parserCompanyKey} onChange={(event) => setParserCompanyKey(event.target.value)} placeholder="es. vf-international" aria-label="Company key" className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface text-strong" /></label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setParserApplyConfig((value) => !value)} className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-semibold ${parserApplyConfig ? 'border-warning-border bg-warning-subtle text-warning' : 'border-edge bg-surface text-body'}`}>{parserApplyConfig ? <ToggleRight size={13} /> : <ToggleLeft size={13} />}{parserApplyConfig ? 'Applica config automaticamente' : 'Solo proposta (no apply)'}</button>
          <button type="button" onClick={() => void runGenerateParser()} disabled={parserLoading || parserLocked} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover disabled:opacity-60 text-on-accent text-xs font-semibold"><Terminal size={13} className={parserLoading ? 'animate-pulse' : ''} />{parserLoading ? 'Generazione…' : parserLocked ? 'Verifica su GitHub' : 'Genera parser AI'}</button>
          {parserLocked && <button type="button" onClick={() => setParserLocked(false)} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-warning-border bg-warning-subtle text-warning text-xs font-semibold">Ho verificato su GitHub, sblocca</button>}
        </div>
        {parserMessage && <AdminMessageBanner message={parserMessage} />}
      </div>

      <details className="group rounded-lg border border-edge bg-surface/50" open>
        <summary className="flex items-center gap-2 px-4 py-3 cursor-pointer select-none"><Shield size={14} className="text-warning" /><span className="text-sm font-semibold text-strong">Filtri qualità</span><span className="ml-auto text-[10px] text-muted">▾</span></summary>
        <div className="px-4 pb-4 space-y-3">
          <p className="text-[11px] text-muted">Soglie minime per accettare un annuncio. Job sotto queste soglie vengono scartati.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-sm text-subtle"><span className="flex items-center gap-1">Punteggio qualità minimo <span className="text-[10px] text-muted">({CRAWLER_CONFIG_LIMITS.minQualityScore.min}–{CRAWLER_CONFIG_LIMITS.minQualityScore.max})</span></span><input type="number" inputMode="numeric" min={CRAWLER_CONFIG_LIMITS.minQualityScore.min} max={CRAWLER_CONFIG_LIMITS.minQualityScore.max} value={config.minQualityScore} onChange={(event) => setConfig((current) => ({ ...current, minQualityScore: Number(event.target.value) }))} aria-label="Punteggio qualità minimo" className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong" /></label>
            <label className="text-sm text-subtle"><span className="flex items-center gap-1">Lunghezza descrizione minima <span className="text-[10px] text-muted">({CRAWLER_CONFIG_LIMITS.minDescriptionChars.min}–{CRAWLER_CONFIG_LIMITS.minDescriptionChars.max} car.)</span></span><input type="number" inputMode="numeric" min={CRAWLER_CONFIG_LIMITS.minDescriptionChars.min} max={CRAWLER_CONFIG_LIMITS.minDescriptionChars.max} value={config.minDescriptionChars} onChange={(event) => setConfig((current) => ({ ...current, minDescriptionChars: Number(event.target.value) }))} aria-label="Lunghezza descrizione minima" className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong" /></label>
          </div>
        </div>
      </details>

      <details className="group rounded-lg border border-edge bg-surface/50">
        <summary className="flex items-center gap-2 px-4 py-3 cursor-pointer select-none"><Activity size={14} className="text-accent" /><span className="text-sm font-semibold text-strong">Traduzione AI</span><span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold ${config.aiLocalizationEnabled ? 'bg-success-subtle text-success' : 'bg-surface-raised text-muted'}`}>{config.aiLocalizationEnabled ? 'ON' : 'OFF'}</span><span className="ml-auto text-[10px] text-muted">▸</span></summary>
        <div className="px-4 pb-4 space-y-3">
          <p className="text-[11px] text-muted">Traduzione automatica annunci in IT/EN/DE/FR tramite LLM (free-first, paid fallback).</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-sm text-subtle">Stato<button type="button" onClick={() => setConfig((current) => ({ ...current, aiLocalizationEnabled: !current.aiLocalizationEnabled }))} className={`mt-1 w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium ${config.aiLocalizationEnabled ? 'border-success-border bg-success-subtle text-success' : 'border-edge bg-surface-alt text-body'}`}>{config.aiLocalizationEnabled ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}{config.aiLocalizationEnabled ? 'Attivo' : 'Disattivo'}</button></label>
            <label className="text-sm text-subtle"><span className="flex items-center gap-1">Max job tradotti per run <span className="text-[10px] text-muted">({CRAWLER_CONFIG_LIMITS.aiLocalizationMaxJobsPerRun.min}–{CRAWLER_CONFIG_LIMITS.aiLocalizationMaxJobsPerRun.max})</span></span><input type="number" inputMode="numeric" min={CRAWLER_CONFIG_LIMITS.aiLocalizationMaxJobsPerRun.min} max={CRAWLER_CONFIG_LIMITS.aiLocalizationMaxJobsPerRun.max} value={config.aiLocalizationMaxJobsPerRun} onChange={(event) => setConfig((current) => ({ ...current, aiLocalizationMaxJobsPerRun: Number(event.target.value) }))} aria-label="Max job tradotti per run" className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong" /></label>
          </div>
        </div>
      </details>

      <details className="group rounded-lg border border-edge bg-surface/50">
        <summary className="flex items-center gap-2 px-4 py-3 cursor-pointer select-none"><Copy size={14} className="text-link" /><span className="text-sm font-semibold text-strong">Riuso traduzioni</span><span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold ${config.contentReuseEnabled ? 'bg-success-subtle text-success' : 'bg-surface-raised text-muted'}`}>{config.contentReuseEnabled ? 'ON' : 'OFF'}</span><span className="ml-auto text-[10px] text-muted">▸</span></summary>
        <div className="px-4 pb-4 space-y-3">
          <p className="text-[11px] text-muted">Se la descrizione di un job è molto simile al run precedente, riusa le traduzioni già fatte (risparmia crediti AI).</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <label className="text-sm text-subtle">Stato<button type="button" onClick={() => setConfig((current) => ({ ...current, contentReuseEnabled: !current.contentReuseEnabled }))} className="mt-1 w-full inline-flex items-center justify-center gap-1 px-2 py-2 rounded-lg border border-edge bg-surface-alt text-sm font-medium">{config.contentReuseEnabled ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}{config.contentReuseEnabled ? 'ON' : 'OFF'}</button></label>
            <label className="text-sm text-subtle"><span>Similarità min <span className="text-[10px] text-muted">({CRAWLER_CONFIG_LIMITS.contentReuse.similarityThreshold.min.toFixed(2)}–{CRAWLER_CONFIG_LIMITS.contentReuse.similarityThreshold.max.toFixed(2)})</span></span><input type="number" min={CRAWLER_CONFIG_LIMITS.contentReuse.similarityThreshold.min} max={CRAWLER_CONFIG_LIMITS.contentReuse.similarityThreshold.max} step={0.01} value={config.contentReuseSimilarityThreshold} onChange={(event) => setConfig((current) => ({ ...current, contentReuseSimilarityThreshold: Number(event.target.value) }))} aria-label="Soglia similarità minima" className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong" /></label>
            <label className="text-sm text-subtle"><span>Char sorgente min <span className="text-[10px] text-muted">({CRAWLER_CONFIG_LIMITS.contentReuse.minSourceChars.min}–{CRAWLER_CONFIG_LIMITS.contentReuse.minSourceChars.max})</span></span><input type="number" min={CRAWLER_CONFIG_LIMITS.contentReuse.minSourceChars.min} max={CRAWLER_CONFIG_LIMITS.contentReuse.minSourceChars.max} value={config.contentReuseMinSourceChars} onChange={(event) => setConfig((current) => ({ ...current, contentReuseMinSourceChars: Number(event.target.value) }))} aria-label="Caratteri sorgente minimi" className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong" /></label>
            <label className="text-sm text-subtle"><span>Delta lunghezza max <span className="text-[10px] text-muted">({CRAWLER_CONFIG_LIMITS.contentReuse.maxLengthDeltaRatio.min.toFixed(2)}–{CRAWLER_CONFIG_LIMITS.contentReuse.maxLengthDeltaRatio.max.toFixed(2)})</span></span><input type="number" min={CRAWLER_CONFIG_LIMITS.contentReuse.maxLengthDeltaRatio.min} max={CRAWLER_CONFIG_LIMITS.contentReuse.maxLengthDeltaRatio.max} step={0.01} value={config.contentReuseMaxLengthDeltaRatio} onChange={(event) => setConfig((current) => ({ ...current, contentReuseMaxLengthDeltaRatio: Number(event.target.value) }))} aria-label="Delta lunghezza massimo" className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong" /></label>
          </div>
        </div>
      </details>

      <details className="group rounded-lg border border-edge bg-surface/50">
        <summary className="flex items-center gap-2 px-4 py-3 cursor-pointer select-none"><Shield size={14} className="text-subtle" /><span className="text-sm font-semibold text-strong">Filtro domini</span><span className="ml-2 text-[10px] text-muted">{domainWhitelistText.split('\n').filter(Boolean).length} whitelist · {domainBlacklistText.split('\n').filter(Boolean).length} blacklist</span><span className="ml-auto text-[10px] text-muted">▸</span></summary>
        <div className="px-4 pb-4 space-y-3">
          <p className="text-[11px] text-muted">Whitelist: se compilata, solo questi domini vengono crawlati. Blacklist: domini sempre esclusi.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-sm text-subtle">Domain Whitelist <span className="text-[10px] text-muted">(1 host per riga)</span><textarea rows={5} value={domainWhitelistText} onChange={(event) => setDomainWhitelistText(event.target.value)} placeholder="esempio.com" aria-label="Domain Whitelist" className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong font-mono text-xs" /></label>
            <label className="text-sm text-subtle">Domain Blacklist <span className="text-[10px] text-muted">(1 host per riga)</span><textarea rows={5} value={domainBlacklistText} onChange={(event) => setDomainBlacklistText(event.target.value)} placeholder="esempio-da-escludere.com" aria-label="Domain Blacklist" className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong font-mono text-xs" /></label>
          </div>
        </div>
      </details>

      <details className="group rounded-lg border border-edge bg-surface/50">
        <summary className="flex items-center gap-2 px-4 py-3 cursor-pointer select-none"><Database size={14} className="text-success" /><span className="text-sm font-semibold text-strong">Priorità aziende &amp; seed URL</span><span className="ml-auto text-[10px] text-muted">▸</span></summary>
        <div className="px-4 pb-4 space-y-3">
          <p className="text-[11px] text-muted">Priorità: punteggio numerico per ordinare le aziende nel crawl. Seed: URL career page iniziali.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-sm text-subtle">Priorità per dominio <span className="text-[10px] text-muted">(JSON: {`{"host": score}`})</span><textarea rows={6} value={companyPriorityByDomainText} onChange={(event) => setCompanyPriorityByDomainText(event.target.value)} aria-label="Priorità per dominio" className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong font-mono text-xs" /></label>
            <label className="text-sm text-subtle">Priorità per nome <span className="text-[10px] text-muted">(JSON: {`{"name": score}`})</span><textarea rows={6} value={companyPriorityByNameText} onChange={(event) => setCompanyPriorityByNameText(event.target.value)} aria-label="Priorità per nome" className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong font-mono text-xs" /></label>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-sm text-subtle">Seed URL per dominio <span className="text-[10px] text-muted">(JSON: {`{"host": ["url1","url2"]}`})</span><textarea rows={6} value={sourceSeedsByDomainText} onChange={(event) => setSourceSeedsByDomainText(event.target.value)} aria-label="Seed URL per dominio" className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong font-mono text-xs" /></label>
            <label className="text-sm text-subtle">Seed URL per nome azienda <span className="text-[10px] text-muted">(JSON: {`{"name": ["url1"]}`})</span><textarea rows={6} value={sourceSeedsByNameText} onChange={(event) => setSourceSeedsByNameText(event.target.value)} aria-label="Seed URL per nome azienda" className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong font-mono text-xs" /></label>
          </div>
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-3 pt-2"><button type="button" onClick={() => void saveConfig()} disabled={saving || loading} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent hover:bg-accent-hover disabled:opacity-60 text-on-accent text-sm font-semibold">{saving ? <RefreshCw size={14} className="animate-spin" /> : <Database size={14} />}Salva configurazione</button><span className="text-[11px] text-muted">Sorgente server-side · applicato al prossimo avvio orchestratore: 09:00 e 21:00 UTC.</span></div>
    </div>
  );
}
