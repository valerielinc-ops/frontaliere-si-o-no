import React, { useState, useEffect } from 'react';
import { Send, Bug, Lightbulb, Github, CheckCircle, Clock, Sparkles, Loader2, MessageSquare, AlertTriangle, ChevronRight, ExternalLink, Lock } from 'lucide-react';
import { Analytics } from '../../services/analytics';
import { reportCaughtError } from '@/services/errorReporter';
import { useTranslation } from '@/services/i18n';
import recaptchaService from '../../services/recaptchaService';
import { getConfigValue } from '../../services/firebase';

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
  const [githubToken, setGithubToken] = useState<string>('');
  const [geminiApiKey, setGeminiApiKey] = useState<string>('');
  
  const [formData, setFormData] = useState<{
    title: string;
    description: string;
    type: 'BUG' | 'FEATURE';
  }>({
    title: '',
    description: '',
    type: 'BUG'
  });

  const REPO_OWNER = 'valerielinc-ops';
  const REPO_NAME = 'frontaliere-si-o-no';

  // Carica le API keys da Firebase Remote Config
  useEffect(() => {
    async function loadApiKeys() {
      try {
        const githubPat = await getConfigValue('GITHUB_PAT');
        const geminiKey = await getConfigValue('GEMINI_API_KEY');
        
        setGithubToken((githubPat || '').trim());
        setGeminiApiKey(geminiKey);
        
        console.log('✅ API keys caricate da Firebase Remote Config');
      } catch (error) {
        console.warn('⚠️ Errore caricamento API keys da Remote Config:', error);
        reportCaughtError(error, 'feedback.loadApiKeys');
        // No local fallback — secrets only from Remote Config
        setGithubToken('');
        setGeminiApiKey('');
      }
    }
    
    loadApiKeys();
  }, []);

  useEffect(() => {
    const fetchIssues = async () => {
      // Attendi che il token sia caricato
      if (!githubToken) return;
      
      try {
        setLoading(true);
        const headers: HeadersInit = {
          'Accept': 'application/vnd.github.v3+json'
        };
        
        // Aggiungi autenticazione se il token è disponibile (necessario per repository privati)
        if (githubToken) {
          headers['Authorization'] = `token ${githubToken}`;
        }
        
        const response = await fetch(
          `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/issues?state=all&per_page=10`,
          { headers }
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
  }, [githubToken]);

  const handleOptimize = async () => {
    if (!formData.description || !geminiApiKey) return;
    setIsOptimizing(true);
    Analytics.trackUIInteraction('supporto', 'feedback', 'ai_ottimizza', 'click', formData.type);
    
    try {
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: geminiApiKey });
      const prompt = `Agisci come un esperto Product Manager. 
      L'utente vuole segnalare un problema o un'idea per un'app di calcolo tasse frontalieri.
      Testo utente: "${formData.description}".
      
      Riscrivi il testo in modo chiaro e tecnico per una GitHub Issue. 
      Non aggiungere saluti. Solo il corpo del testo.`;

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt
      });
      const optimizedText = response.text || formData.description;
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
    
    if (!githubToken) {
      setSubmitError(t('feedback.missingToken'));
      reportCaughtError(new Error('Missing GitHub Token'), 'feedback.missingToken');
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      // Verifica reCAPTCHA prima di inviare il feedback
      await recaptchaService.canProceed('FEEDBACK_SUBMIT');

      const response = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/issues`, {
        method: 'POST',
        headers: {
          'Authorization': `token ${githubToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github.v3+json'
        },
        body: JSON.stringify({
          title: formData.title,
          body: formData.description + "\n\n> Segnalato tramite Web App",
          labels: [formData.type === 'BUG' ? 'bug' : 'enhancement']
        })
      });

      if (response.ok) {
        const newIssue = await response.json();
        // Add locally to list immediately
        const newItem: FeedbackItem = {
           id: String(newIssue.id),
           title: newIssue.title,
           description: newIssue.body,
           type: formData.type,
           status: 'OPEN',
           createdAt: new Date().toISOString(),
           author: newIssue.user.login,
           url: newIssue.html_url
        };
        setItems(prev => [newItem, ...prev]);
        Analytics.trackFeedback('submit', formData.type);
        setFormData({ title: '', description: '', type: 'BUG' });
        alert(t('feedback.submitSuccess'));
      } else {
        const err = await response.json();
        throw new Error(err.message || "Errore invio");
      }
    } catch (error: any) {
      setSubmitError(`${t('feedback.apiError')}: ${error.message}`);
      reportCaughtError(error, 'feedback.githubIssuePost', { apiEndpoint: `github.com/repos/${REPO_OWNER}/${REPO_NAME}/issues` });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-8 pb-12">
      {/* Introduction */}
      <div className="text-center space-y-3">
        <h2 className="text-2xl sm:text-3xl font-bold text-slate-800 dark:text-slate-100 tracking-tight">{t('feedback.title')}</h2>
        <p className="text-subtle max-w-xl mx-auto text-sm leading-relaxed">
          {t('feedback.subtitle')}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
        {/* Form Section */}
        <div className="bg-surface p-4 sm:p-6 rounded-2xl border border-edge shadow-sm">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 rounded-xl">
              <MessageSquare size={20} />
            </div>
            <h3 className="font-bold text-slate-800 dark:text-slate-100 uppercase tracking-wider text-xs">{t('feedback.prepareReport')}</h3>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3 mb-2">
              <button 
                type="button"
                onClick={() => setFormData(prev => ({...prev, type: 'BUG'}))}
                className={`p-3 rounded-2xl border-2 transition-colors flex items-center gap-2 justify-center font-bold text-xs ${formData.type === 'BUG' ? 'border-red-500 bg-red-50 dark:bg-red-900/20 text-red-600' : 'border-slate-100 dark:border-slate-800 text-muted'}`}
              >
                <Bug size={16} /> Bug
              </button>
              <button 
                type="button"
                onClick={() => setFormData(prev => ({...prev, type: 'FEATURE'}))}
                className={`p-3 rounded-2xl border-2 transition-colors flex items-center gap-2 justify-center font-bold text-xs ${formData.type === 'FEATURE' ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600' : 'border-slate-100 dark:border-slate-800 text-muted'}`}
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
                className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 px-4 py-3 rounded-2xl outline-none focus-visible:ring-4 focus-visible:ring-indigo-50 dark:focus-visible:ring-indigo-900/20 focus-visible:border-indigo-500 transition-[color,background-color,border-color,box-shadow] text-sm"
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
                className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 px-4 py-3 rounded-2xl outline-none focus-visible:ring-4 focus-visible:ring-indigo-50 dark:focus-visible:ring-indigo-900/20 focus-visible:border-indigo-500 transition-[color,background-color,border-color,box-shadow] text-sm resize-none"
                placeholder={t('feedback.detailsPlaceholder')}
              />
              <button 
                type="button"
                onClick={handleOptimize}
                disabled={isOptimizing || !formData.description}
                className="absolute right-3 bottom-3 p-2 bg-indigo-600 text-white rounded-xl shadow-lg shadow-indigo-500/30 hover:bg-indigo-700 transition-[color,background-color,border-color,opacity] disabled:opacity-50 disabled:shadow-none flex items-center gap-2 text-xs font-bold uppercase"
              >
                {isOptimizing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                AI Help
              </button>
            </div>
            
            {submitError && (
              <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-sm text-red-600 flex items-center gap-2">
                 <AlertTriangle size={14}/> {submitError}
              </div>
            )}

            <button 
              type="submit"
              disabled={isSubmitting || !formData.title}
              className="w-full py-4 bg-slate-800 dark:bg-slate-100 dark:text-slate-900 text-white rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-slate-900 dark:hover:bg-white transition-[color,background-color,border-color,opacity] shadow-xl shadow-slate-500/10 disabled:opacity-50"
            >
              {isSubmitting ? <Loader2 size={18} className="animate-spin" /> : <Github size={18} />}
              {t('feedback.openIssue')}
            </button>
            
            {!githubToken && (
              <p className="text-xs text-center text-muted">
                <Lock size={10} className="inline mr-1"/>
                {t('feedback.requiresToken')}
              </p>
            )}
          </form>
        </div>

        {/* List Section */}
        <div className="space-y-4">
          <div className="flex items-center justify-between px-2">
            <h3 className="text-xs font-bold text-muted uppercase tracking-widest flex items-center gap-2">
              <Github size={14} /> {t('feedback.recentActivity')}
            </h3>
            <a href={`https://github.com/${REPO_OWNER}/${REPO_NAME}/issues`} target="_blank" rel="noreferrer" className="text-xs bg-slate-200 dark:bg-slate-800 px-2 py-0.5 rounded-full font-bold text-muted hover:text-indigo-500 flex items-center gap-1 transition-colors">
              {t('feedback.viewAll')} <ExternalLink size={8} />
            </a>
          </div>

          <div className="space-y-3 max-h-[600px] overflow-y-auto custom-scrollbar pr-2">
            {loading ? (
               <div className="flex justify-center py-10"><Loader2 size={24} className="animate-spin text-slate-300"/></div>
            ) : items.length > 0 ? (
              items.map(item => (
                <a 
                  key={item.id} 
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block bg-surface border border-slate-100 dark:border-slate-800 p-4 rounded-2xl shadow-sm hover:shadow-md transition-[color,background-color,border-color,box-shadow] group hover:border-indigo-200 dark:hover:border-indigo-900"
                  onClick={() => Analytics.trackSelectContent('issue', String(item.id))}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex gap-3">
                      <div className={`mt-1 shrink-0 ${item.type === 'BUG' ? 'text-red-500' : 'text-indigo-500'}`}>
                        {item.type === 'BUG' ? <Bug size={16} /> : <Lightbulb size={16} />}
                      </div>
                      <div>
                        <h4 className="text-sm font-bold text-slate-800 dark:text-slate-100 line-clamp-1 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">{item.title}</h4>
                        <p className="text-sm text-subtle line-clamp-2 mt-1 leading-relaxed">
                          {item.description}
                        </p>
                        <div className="flex items-center gap-3 mt-3">
                          <span className={`text-xs font-bold px-1.5 py-0.5 rounded flex items-center gap-1 ${item.status === 'OPEN' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20' : 'bg-surface-raised text-muted'}`}>
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
              <div className="text-center py-12 bg-surface-alt/50 rounded-3xl border-2 border-dashed border-slate-200 dark:border-slate-800">
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