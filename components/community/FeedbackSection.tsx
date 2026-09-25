import React, { useState, useEffect } from 'react';
import { Send, Bug, Lightbulb, Github, CheckCircle, Clock, Sparkles, Loader2, MessageSquare, AlertTriangle, ChevronRight, ExternalLink } from 'lucide-react';
import { Analytics } from '../../services/analytics';
import { reportCaughtError } from '@/services/errorReporter';
import { useTranslation } from '@/services/i18n';
import { redactPersonalData } from '@/services/privacy/redactPii';
import recaptchaService from '../../services/recaptchaService';

interface FeedbackItem {
 id: string;
 title: string;
 description: string;
 type: 'BUG' | 'FEATURE';
 status: 'OPEN' | 'CLOSED';
 createdAt: string;
 author: string;
 url: string;
}

export const FeedbackSection: React.FC = () => {
 const { t } = useTranslation();
 const [items, setItems] = useState<FeedbackItem[]>([]);
 const [loading, setLoading] = useState(true);
 const [isOptimizing, setIsOptimizing] = useState(false);
 const [isSubmitting, setIsSubmitting] = useState(false);
 const [submitError, setSubmitError] = useState<string | null>(null);

 const [formData, setFormData] = useState<{
 title: string;
 description: string;
 type: 'BUG' | 'FEATURE';
 }>({
 title: '',
 description: '',
 type: 'BUG'
 });

 /**
  * Redact personal data out of anything this form sends (#5196).
  *
  * ── WHY THIS FORM, AND WHY IT IS THE WORST SINK OF THE SET ──
  *
  * The #5196 inventory tracked eleven destinations for user-authored free text
  * and fixed the analytics ones. It missed this form, which is not an analytics
  * sink at all: `handleSubmit` posts the title and the body to
  * `createFeedbackIssue`, which opens an issue on a **public** repository. That
  * is a worse destination than every entry on that list. A PostHog event or a
  * session replay can be deleted by the owner; a public GitHub issue is
  * world-readable the instant it is created, is indexed, and is mirrored by
  * scrapers before anyone notices. Deleting it does not undo any of that.
  *
  * The class of input is identical to the one that started the issue: a person
  * describing their own situation. On this site a bug report reads "sono Mario
  * Rossi, nato il 14/03/1987, abito in Via …, e il calcolatore mi dà un
  * risultato sbagliato" — the same three fields, aimed at a public URL.
  *
  * ── THE FALSE-POSITIVE TRADE, STATED ──
  *
  * `inferNamesFromCapitalisation` is left ON — the protective default — and not
  * turned off as it is for the search box. Two reasons, in order:
  *
  *  1. The destination is public and permanent, so the module's asymmetry
  *     (over-redaction costs readability, under-redaction is an incident)
  *     applies here more strongly than anywhere else in the codebase.
  *  2. The readability cost is close to zero HERE, because the volume is: one
  *     issue in the repository's whole history carries the "Segnalato tramite
  *     Web App" marker this endpoint appends. There is no corpus to preserve,
  *     and when a report does arrive over-redacted the reporter is reachable,
  *     which a leaked name is not.
  *
  * The cost that remains is real and is not hidden: a capitalised UI label in a
  * report ("il bottone Calcola Stipendio") is reported as `[name]`.
  */
 const redactForPublication = (raw: string) => redactPersonalData(raw).text;

 const REPO_OWNER = 'valerielinc-ops';
 const REPO_NAME = 'frontaliere-si-o-no';
 // Issue creation goes through a Cloud Function that holds the repo PAT
 // server-side; the browser never sees a write token.
 const FEEDBACK_ISSUE_ENDPOINT = 'https://europe-west6-frontaliere-ticino.cloudfunctions.net/createFeedbackIssue';

 useEffect(() => {
 const fetchIssues = async () => {
 try {
 setLoading(true);
 // Public repo → list issues unauthenticated (no PAT in the browser).
 const response = await fetch(
 `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/issues?state=all&per_page=10`,
 { headers: { 'Accept': 'application/vnd.github.v3+json' } }
 );

 if (response.ok) {
 const data = await response.json();
 const mappedItems: FeedbackItem[] = data.map((issue: any) => ({
 id: String(issue.id),
 title: issue.title,
 description: issue.body || t('feedback.noDescription'),
 type: issue.labels.some((l: any) => l.name.toLowerCase().includes('bug')) ? 'BUG' : 'FEATURE',
 status: issue.state === 'closed' ? 'CLOSED' : 'OPEN',
 createdAt: issue.created_at,
 author: issue.user.login,
 url: issue.html_url
 }));
 setItems(mappedItems);
 }
 } catch (error) {
 console.error("Failed to fetch issues", error);
 reportCaughtError(error, 'feedback.fetchIssues', { type: 'api_error' });
 } finally {
 setLoading(false);
 }
 };

 fetchIssues();
 }, []);

 const handleOptimize = async () => {
 if (!formData.description) return;
 setIsOptimizing(true);
 Analytics.trackUIInteraction('supporto', 'feedback', 'ai_ottimizza', 'click', formData.type);

 try {
 // Redacted BEFORE the vendor call, not only before the issue is opened.
 // The rewrite is cosmetic — a Product-Manager-style restatement — so it loses
 // nothing by working on `[name]`/`[address]` tokens, and redacting here
 // removes one third-party copy of the raw text instead of only cleaning the
 // final destination. It also makes the redaction VISIBLE: the rewritten text
 // is written straight back into the textarea, so the reporter sees what will
 // be published before they submit it.
 //
 // This is the opposite call from the chatbot's LLM cascade, deliberately:
 // there the user typed the question in order to be answered, and degrading
 // the prompt degrades the service they asked for. Here the service is a
 // rephrasing, and it is just as good on redacted input.
 const safeDescription = redactForPublication(formData.description);
 // Gemini runs server-side (geminiGenerate Cloud Function); no API key in the browser.
 const userPrompt = `Agisci come un esperto Product Manager. L'utente vuole segnalare un problema o un'idea per un'app di calcolo tasse frontalieri.\nTesto utente: "${safeDescription}".\n\nRiscrivi il testo in modo chiaro e tecnico per una GitHub Issue. Non aggiungere saluti. Solo il corpo del testo.`;
 const res = await fetch('https://europe-west6-frontaliere-ticino.cloudfunctions.net/geminiGenerate', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ userPrompt, maxTokens: 1024, temperature: 0.5 }),
 });
 const data = await res.json().catch(() => ({}));
 // On failure fall back to the REDACTED text, not the raw one: the point of
 // the fallback is to leave the field usable, not to put the personal data
 // back in it.
 const optimizedText = (data?.ok && data.text) ? data.text : safeDescription;
 setFormData(prev => ({ ...prev, description: optimizedText }));
 } catch (e) {
 reportCaughtError(e, 'feedback.aiOptimize');
 } finally {
 setIsOptimizing(false);
 }
 };

 const handleSubmit = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!formData.title) return;
 
 setIsSubmitting(true);
 setSubmitError(null);

 try {
 // Generate a reCAPTCHA token; the Cloud Function verifies it server-side
 // before spending the repo PAT (which never reaches the browser).
 const recaptchaToken = await recaptchaService.executeRecaptcha('FEEDBACK_SUBMIT');
 if (!recaptchaToken) {
 setSubmitError(t('feedback.submitError') || 'Verifica anti-bot fallita. Riprova.');
 reportCaughtError(new Error('recaptcha_token_failed'), 'feedback.recaptcha');
 setIsSubmitting(false);
 return;
 }

 // Both fields, not just the body: a reporter who writes "il calcolatore
 // sbaglia per Mario Rossi" puts the name in the TITLE, which is the part
 // that ends up in the issue list, in search results and in every
 // notification email.
 const response = await fetch(FEEDBACK_ISSUE_ENDPOINT, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({
 title: redactForPublication(formData.title),
 description: redactForPublication(formData.description),
 type: formData.type,
 recaptchaToken,
 }),
 });

 const result = await response.json().catch(() => ({}));
 if (response.ok && result.ok && result.issue) {
 // Add locally to list immediately
 const newItem: FeedbackItem = {
 id: result.issue.id,
 title: result.issue.title,
 description: result.issue.body,
 type: formData.type,
 status: 'OPEN',
 createdAt: new Date().toISOString(),
 author: result.issue.author,
 url: result.issue.url
 };
 setItems(prev => [newItem, ...prev]);
 Analytics.trackFeedback('submit', formData.type);
 setFormData({ title: '', description: '', type: 'BUG' });
 alert(t('feedback.submitSuccess'));
 } else {
 throw new Error(result.error || 'Errore invio');
 }
 } catch (error: any) {
 setSubmitError(`${t('feedback.apiError')}: ${error.message}`);
 reportCaughtError(error, 'feedback.githubIssuePost', { apiEndpoint: 'createFeedbackIssue' });
 } finally {
 setIsSubmitting(false);
 }
 };

 return (
 <div className="space-y-8 pb-12">
 {/* Introduction */}
 <div className="text-center space-y-3">
 <h2 className="text-2xl sm:text-3xl font-bold font-display text-strong tracking-tight">{t('feedback.title')}</h2>
 <p className="text-subtle max-w-xl mx-auto text-sm leading-relaxed">
 {t('feedback.subtitle')}
 </p>
 </div>

 <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
 {/* Form Section */}
 <div className="bg-surface p-4 sm:p-6 rounded-2xl border border-edge shadow-sm">
 <div className="flex items-center gap-3 mb-6">
 <div className="p-2 bg-accent-subtle text-accent rounded-xl">
 <MessageSquare size={20} />
 </div>
 <h3 className="font-bold text-strong uppercase tracking-wider text-xs">{t('feedback.prepareReport')}</h3>
 </div>

 <form onSubmit={handleSubmit} className="space-y-4">
 <div className="grid grid-cols-2 gap-3 mb-2">
 <button 
 type="button"
 onClick={() => setFormData(prev => ({...prev, type: 'BUG'}))}
 className={`p-3 rounded-2xl border-2 transition-colors flex items-center gap-2 justify-center font-bold text-xs ${formData.type === 'BUG' ? 'border-danger bg-danger-subtle text-danger' : 'border-edge text-muted'}`}
 >
 <Bug size={16} /> Bug
 </button>
 <button 
 type="button"
 onClick={() => setFormData(prev => ({...prev, type: 'FEATURE'}))}
 className={`p-3 rounded-2xl border-2 transition-colors flex items-center gap-2 justify-center font-bold text-xs ${formData.type === 'FEATURE' ? 'border-accent bg-accent-subtle text-accent' : 'border-edge text-muted'}`}
 >
 <Lightbulb size={16} /> Feature
 </button>
 </div>

 <div className="space-y-1">
 <label htmlFor="feedback-title" className="text-xs font-bold text-muted uppercase ml-1">{t('feedback.titleLabel')}</label>
 <input 
 id="feedback-title"
 value={formData.title}
 onChange={e => setFormData(prev => ({...prev, title: e.target.value}))}
 className="w-full bg-surface-alt border border-edge px-4 py-3 rounded-2xl outline-none focus-visible:ring-4 focus-visible:ring-accent-subtle focus-visible:border-accent transition-[color,background-color,border-color,box-shadow] text-sm"
 placeholder={t('feedback.titlePlaceholder')}
 />
 </div>

 <div className="space-y-1 relative">
 <label htmlFor="feedback-details" className="text-xs font-bold text-muted uppercase ml-1">{t('feedback.detailsLabel')}</label>
 <textarea 
 id="feedback-details"
 value={formData.description}
 onChange={e => setFormData(prev => ({...prev, description: e.target.value}))}
 rows={5}
 className="w-full bg-surface-alt border border-edge px-4 py-3 rounded-2xl outline-none focus-visible:ring-4 focus-visible:ring-accent-subtle focus-visible:border-accent transition-[color,background-color,border-color,box-shadow] text-sm resize-none"
 placeholder={t('feedback.detailsPlaceholder')}
 />
 <button 
 type="button"
 onClick={handleOptimize}
 disabled={isOptimizing || !formData.description}
 className="absolute right-3 bottom-3 p-2 bg-accent-strong text-on-accent rounded-xl shadow-lg shadow-accent/30 hover:bg-accent-strong-hover transition-[color,background-color,border-color,opacity] disabled:opacity-50 disabled:shadow-none flex items-center gap-2 text-xs font-bold uppercase"
 >
 {isOptimizing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
 AI Help
 </button>
 </div>
 
 {submitError && (
 <div className="p-3 bg-danger-subtle border border-danger-border rounded-xl text-sm text-danger flex items-center gap-2">
 <AlertTriangle size={14}/> {submitError}
 </div>
 )}

 <button 
 type="submit"
 disabled={isSubmitting || !formData.title}
 className="w-full py-4 bg-heading text-surface rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-heading transition-[color,background-color,border-color,opacity] shadow-xl shadow-black/10 disabled:opacity-50"
 >
 {isSubmitting ? <Loader2 size={18} className="animate-spin" /> : <Github size={18} />}
 {t('feedback.openIssue')}
 </button>
 </form>
 </div>

 {/* List Section */}
 <div className="space-y-4">
 <div className="flex items-center justify-between px-2">
 <h3 className="text-xs font-bold text-muted uppercase tracking-widest flex items-center gap-2">
 <Github size={14} /> {t('feedback.recentActivity')}
 </h3>
 <a href={`https://github.com/${REPO_OWNER}/${REPO_NAME}/issues`} target="_blank" rel="noreferrer" className="text-xs bg-surface-raised px-2 py-0.5 rounded-full font-bold text-muted hover:text-accent flex items-center gap-1 transition-colors">
 {t('feedback.viewAll')} <ExternalLink size={8} />
 </a>
 </div>

 <div className="space-y-3 max-h-[600px] overflow-y-auto custom-scrollbar pr-2">
 {loading ? (
 <div className="flex justify-center py-10"><Loader2 size={24} className="animate-spin text-body"/></div>
 ) : items.length > 0 ? (
 items.map(item => (
 <a 
 key={item.id} 
 href={item.url}
 target="_blank"
 rel="noreferrer"
 className="block bg-surface border border-edge p-4 rounded-2xl shadow-sm hover:shadow-md transition-[color,background-color,border-color,box-shadow] group hover:border-accent-border "
 onClick={() => Analytics.trackSelectContent('issue', String(item.id))}
 >
 <div className="flex items-start justify-between gap-3">
 <div className="flex gap-3">
 <div className={`mt-1 shrink-0 ${item.type === 'BUG' ? 'text-danger' : 'text-accent'}`}>
 {item.type === 'BUG' ? <Bug size={16} /> : <Lightbulb size={16} />}
 </div>
 <div>
 <h4 className="text-sm font-bold text-strong line-clamp-1 group-hover:text-accent transition-colors">{item.title}</h4>
 <p className="text-sm text-subtle line-clamp-2 mt-1 leading-relaxed">
 {item.description}
 </p>
 <div className="flex items-center gap-3 mt-3">
 <span className={`text-xs font-bold px-1.5 py-0.5 rounded flex items-center gap-1 ${item.status === 'OPEN' ? 'bg-success-subtle text-success' : 'bg-surface-raised text-muted'}`}>
 {item.status === 'OPEN' ? <Clock size={10} /> : <CheckCircle size={10} />}
 {item.status}
 </span>
 <span className="text-sm text-muted flex items-center gap-1 font-medium">
 <Clock size={10} /> {new Date(item.createdAt).toLocaleDateString()}
 </span>
 </div>
 </div>
 </div>
 <ChevronRight size={14} className="text-muted group-hover:translate-x-1 transition-transform" />
 </div>
 </a>
 ))
 ) : (
 <div className="text-center py-12 bg-surface-alt/50 rounded-3xl border-2 border-dashed border-edge">
 <Github size={32} className="mx-auto text-muted mb-3" />
 <p className="text-sm text-muted">{t('feedback.noReports')}</p>
 </div>
 )}
 </div>
 </div>
 </div>
 </div>
 );
};