import { useEffect, useState } from 'react';
import { Calendar, Eye, Mail, RefreshCw, Send, Terminal, Users } from 'lucide-react';
import { buildNewsletterPreviewHtml } from '@/services/newsletterPreview';
import { useAuth } from '@/services/authService';
import { useAdminWorkflow } from '@/components/admin/AdminWorkflowProvider';
import { CopyButton } from '@/components/admin/ui/CopyButton';
import { AdminMessageBanner, type AdminMessage } from '@/components/admin/ui/AdminMessageBanner';
import type { NewsletterInsight } from '@/components/admin/lib/adminTypes';
import { loadNewsletterStats } from '@/components/admin/lib/newsletterStats';

function computeNewsletterInsights(series: Array<{ date: string; rate: number }>): NewsletterInsight | null {
  if (!series.length) return null;
  const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const latest = series[series.length - 1].rate;
  const previousWeekRate = series[Math.max(0, series.length - 8)]?.rate || latest;
  const weeklyDeltaPct = previousWeekRate > 0 ? ((latest - previousWeekRate) / previousWeekRate) * 100 : 0;
  const now = new Date();
  const previousMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const currentMonthValues = series.filter((point) => { const date = new Date(`${point.date}T00:00:00`); return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear(); }).map((point) => point.rate);
  const previousMonthValues = series.filter((point) => { const date = new Date(`${point.date}T00:00:00`); return date.getMonth() === previousMonthDate.getMonth() && date.getFullYear() === previousMonthDate.getFullYear(); }).map((point) => point.rate);
  const currentMonthAvg = mean(currentMonthValues) || latest;
  const previousMonthAvg = mean(previousMonthValues) || previousWeekRate;
  const monthDeltaPct = previousMonthAvg > 0 ? ((currentMonthAvg - previousMonthAvg) / previousMonthAvg) * 100 : 0;
  const weekdays = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];
  const buckets = new Map<number, number[]>();
  for (const point of series) { const weekday = new Date(`${point.date}T00:00:00`).getDay(); buckets.set(weekday, [...(buckets.get(weekday) || []), point.rate]); }
  let bestWeekday = 'N/D'; let best = -Infinity;
  for (const [weekday, values] of buckets) { const average = mean(values); if (average > best) { best = average; bestWeekday = weekdays[weekday] || 'N/D'; } }
  const providers = [{ name: 'Wise', feePct: 0.0025 }, { name: 'Cambiovalute.ch', feePct: 0.0031 }, { name: 'Revolut', feePct: 0.0028 }];
  const providerRanking = providers.map((provider) => ({ name: provider.name, netEur: (1000 * (1 - provider.feePct)) * latest })).sort((a, b) => b.netEur - a.netEur);
  const recommendation = monthDeltaPct >= 0.4 ? 'Fine mese favorevole: possibile conversione graduale CHF→EUR.' : monthDeltaPct <= -0.4 ? 'Fine mese debole: meglio strategia a tranche e monitoraggio settimanale.' : 'Fine mese neutro: procedi a tranche e usa il comparatore per il provider.';
  return { currentRate: latest, previousWeekRate, weeklyDeltaPct, currentMonthAvg, previousMonthAvg, monthDeltaPct, bestWeekday, providerRanking, recommendation };
}

export default function NewsletterSection() {
  const { user } = useAuth();
  const workflow = useAdminWorkflow();
  const [subscriberCount, setSubscriberCount] = useState<number | null>(null);
  const [lastSend, setLastSend] = useState<string | null>(null);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [subject, setSubject] = useState('');
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AdminMessage | null>(null);
  const [insights, setInsights] = useState<NewsletterInsight | null>(null);
  const [insightLoading, setInsightLoading] = useState(false);

  const fetchInsights = async () => {
    setInsightLoading(true);
    try {
      const end = new Date(); const start = new Date(end); start.setUTCDate(end.getUTCDate() - 120);
      let series: Array<{ date: string; rate: number }> = [];
      for (const base of ['https://api.frankfurter.dev/v2/rates', 'https://api.frankfurter.app/v2/rates']) {
        try { const response = await fetch(`${base}?base=CHF&quotes=EUR&from=${start.toISOString().slice(0, 10)}&to=${end.toISOString().slice(0, 10)}`); if (!response.ok) continue; const data = await response.json(); series = (Array.isArray(data) ? data : []).map((entry: { date: string; rate: number }) => ({ date: entry.date, rate: Number(entry.rate || 0) })).filter((entry) => Number.isFinite(entry.rate) && entry.rate > 0).sort((a, b) => a.date.localeCompare(b.date)); if (series.length >= 20) break; } catch { /* try next endpoint */ }
      }
      setInsights(computeNewsletterInsights(series));
    } finally { setInsightLoading(false); }
  };

  useEffect(() => {
    let cancelled = false;
    void fetchInsights();
    (async () => {
      setLoading(true);
      try {
        const stats = await loadNewsletterStats();
        if (!cancelled) { setSubscriberCount(stats.subscriberCount); setLastSend(stats.lastSend); setRecipients(stats.recipients); }
      } catch (error) { console.warn('[AdminPanel] Newsletter stats load failed:', error); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  const generatePreview = async () => {
    setPreviewLoading(true); setResult(null);
    try { const preview = await buildNewsletterPreviewHtml({ subject: subject.trim() || '' }); setPreviewHtml(preview.html); if (!subject.trim() || subject === 'Il briefing della settimana') setSubject(preview.subject); }
    catch (error) { setResult({ kind: 'error', text: `Errore generazione anteprima: ${error instanceof Error ? error.message : String(error)}` }); }
    finally { setPreviewLoading(false); }
  };

  const sendTest = async () => {
    if (sending || workflow.isRunning('send-newsletter.yml')) return;
    if (!user?.email) { setResult({ kind: 'error', text: 'Nessuna email admin disponibile nella sessione corrente.' }); return; }
    setSending(true); setResult(null);
    try {
      const state = await workflow.runWorkflowAction('send-newsletter.yml', { mode: 'test', target_email: String(user.email).trim().toLowerCase(), subject: subject.trim() || 'Il briefing della settimana' });
      const outcome = workflow.classifyOutcome(state);
      if (outcome === 'unknown') setResult({ kind: 'warn', text: `Run newsletter avviato, esito da verificare in GitHub Actions: ${state.error || state.message || 'non ricliccare.'}` });
      else if (outcome === 'success' && state.conclusion === 'success') setResult({ kind: 'ok', text: `Email test inviata a ${String(user.email).trim().toLowerCase()}.` });
      else setResult({ kind: 'error', text: `Invio test non riuscito: ${state.error || state.message || 'controlla il workflow GitHub.'}` });
    } catch (error) { setResult({ kind: 'error', text: `Errore: ${error instanceof Error ? error.message : String(error)}` }); }
    finally { setSending(false); }
  };

  return (
    <div className="space-y-4">
      <div className="bg-warning-subtle border border-warning-border rounded-xl p-4 text-sm text-warning"><strong>Preview reale:</strong> l&apos;anteprima usa dati veri. Il test invia una sola email all&apos;admin loggato tramite workflow protetto.</div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4"><div className="bg-surface rounded-xl border border-edge p-4"><div className="flex items-center gap-2 text-subtle text-sm mb-1"><Users size={16} />Iscritti attivi</div><div className="text-2xl font-bold text-strong">{loading ? '…' : subscriberCount ?? '—'}</div></div><div className="bg-surface rounded-xl border border-edge p-4"><div className="flex items-center gap-2 text-subtle text-sm mb-1"><Calendar size={16} />Ultimo invio</div><div className="text-sm font-medium text-strong mt-1">{loading ? '…' : lastSend ?? 'Nessun invio'}</div></div><div className="bg-surface rounded-xl border border-edge p-4"><div className="flex items-center gap-2 text-subtle text-sm mb-1"><Mail size={16} />Destinatari (anteprima)</div><div className="text-xs text-subtle mt-1 space-y-0.5">{loading ? '…' : recipients.length ? recipients.map((recipient) => <div key={recipient} className="font-mono">{recipient}</div>) : <span>Nessun iscritto</span>}</div></div></div>
      <div className="bg-surface rounded-xl border border-edge p-6 space-y-3"><div className="flex items-center justify-between"><h3 className="text-sm font-bold text-strong">Insight Cambio (settimana/mese)</h3><button type="button" onClick={() => void fetchInsights()} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-raised text-xs font-medium"><RefreshCw size={13} />Aggiorna</button></div>{insightLoading ? <div className="text-sm text-muted">Calcolo insight in corso…</div> : insights ? <div className="space-y-3"><div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm"><div className="rounded-lg bg-surface-alt p-3"><div className="text-muted text-xs mb-1">Settimana vs precedente</div><div className="font-semibold text-strong">{insights.weeklyDeltaPct >= 0 ? '+' : ''}{insights.weeklyDeltaPct.toFixed(2)}%</div></div><div className="rounded-lg bg-surface-alt p-3"><div className="text-muted text-xs mb-1">Mese corrente vs precedente</div><div className="font-semibold text-strong">{insights.monthDeltaPct >= 0 ? '+' : ''}{insights.monthDeltaPct.toFixed(2)}%</div></div><div className="rounded-lg bg-surface-alt p-3"><div className="text-muted text-xs mb-1">Giorno medio migliore</div><div className="font-semibold text-strong">{insights.bestWeekday}</div></div></div><div className="text-sm text-body">{insights.recommendation}</div><div className="rounded-lg border border-edge p-3"><div className="text-xs text-muted mb-2">Provider consigliati (netto su 1.000 CHF)</div>{insights.providerRanking.map((provider) => <div key={provider.name} className="flex items-center justify-between text-sm"><span>{provider.name}</span><span className="font-semibold">{provider.netEur.toFixed(2)} EUR</span></div>)}</div><a href="/compara-servizi/cambio-franco-euro/" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-link hover:underline">Apri miglior comparatore cambio →</a></div> : <div className="text-sm text-muted">Insight non disponibili.</div>}</div>
      <div className="bg-surface rounded-xl border border-edge p-6 space-y-4"><h2 className="text-lg font-bold font-display text-strong flex items-center gap-2"><Mail size={20} className="text-accent" />Configura Newsletter</h2><label htmlFor="nl-subject" className="block text-sm font-medium text-body">Oggetto email<input id="nl-subject" value={subject} onChange={(event) => setSubject(event.target.value)} className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface text-strong text-sm" aria-label="Oggetto email newsletter" /></label><div className="rounded-lg border border-edge bg-surface-alt p-4"><p className="text-sm font-semibold text-strong mb-2">Newsletter v2 — AI Personalizzata</p><p className="text-xs text-subtle leading-relaxed">Ogni iscritto riceve un&apos;email unica: briefing AI personalizzato, job matching per zona/settore, oggetto generato dall&apos;AI. Non ci sono più varianti (jobs/tax/general) né sezioni configurabili. Il template è fisso e minimale.</p></div><div className="flex flex-wrap gap-3 pt-2"><button type="button" onClick={() => void generatePreview()} disabled={previewLoading} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-on-accent text-sm font-medium"><RefreshCw size={16} />{previewLoading ? 'Genero…' : 'Genera Preview'}</button><button type="button" onClick={() => void sendTest()} disabled={sending || workflow.isRunning('send-newsletter.yml') || !previewHtml || !user?.email} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-on-accent disabled:opacity-50 text-sm font-medium"><Send size={16} />{sending ? 'Invio…' : `Invia Test${user?.email ? ` a ${String(user.email).trim().toLowerCase()}` : ''}`}</button></div>{result && <AdminMessageBanner message={result} />}</div>
      {previewHtml && <div className="bg-surface rounded-xl border border-edge overflow-hidden"><div className="px-4 py-3 border-b border-edge flex items-center gap-2"><Eye size={16} className="text-accent" /><span className="text-sm font-semibold text-strong">Anteprima Newsletter</span></div><iframe srcDoc={previewHtml} title="Newsletter preview" className="w-full border-0 h-[680px]" sandbox="allow-same-origin" /></div>}
      <div className="bg-surface rounded-xl border border-edge p-6 space-y-3"><h3 className="text-sm font-bold text-strong flex items-center gap-2"><Terminal size={16} className="text-accent" />Comandi Newsletter</h3>{[{ label: 'Preview HTML', cmd: 'node scripts/send-newsletter.mjs --preview > /tmp/newsletter.html && open /tmp/newsletter.html' }, { label: 'Check Resend domain', cmd: 'RESEND_API_KEY=... NEWSLETTER_FROM="Frontaliere Ticino <newsletter@frontaliereticino.ch>" node scripts/check-resend-domain.mjs' }, { label: 'Invio test (solo go-live)', cmd: 'NEWSLETTER_EXPERIMENTAL_MODE=false NEWSLETTER_ENABLE_SEND=true GOOGLE_APPLICATION_CREDENTIALS=path/to/sa.json node scripts/send-newsletter.mjs --test' }, { label: 'Invio a tutti (solo go-live)', cmd: 'NEWSLETTER_EXPERIMENTAL_MODE=false NEWSLETTER_ENABLE_SEND=true GOOGLE_APPLICATION_CREDENTIALS=path/to/sa.json node scripts/send-newsletter.mjs --send' }].map((item) => <div key={item.label} className="flex items-center gap-2"><span className="text-sm text-muted w-24 shrink-0">{item.label}:</span><CopyButton text={item.cmd} label={item.label} /></div>)}</div>
    </div>
  );
}
