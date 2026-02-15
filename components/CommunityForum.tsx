import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from '@/services/i18n';
import { useAuth, getUserDisplayName, getUserPhotoURL } from '@/services/authService';
import {
  getQuestions,
  getAnswers,
  createQuestion,
  createAnswer,
  upvoteQuestion,
  upvoteAnswer,
  FORUM_CATEGORIES,
  ForumQuestion,
  ForumAnswer,
  ForumCategory,
} from '@/services/firestoreService';
import { unlockAchievement } from '@/components/GamificationWidget';
import { Analytics } from '@/services/analytics';
import {
  MessageSquare, ThumbsUp, Send, ArrowLeft, Tag, Filter,
  Plus, User, Clock, ChevronDown, LogIn, AlertCircle,
  MessageCircle, TrendingUp, Loader2, CheckCircle2,
} from 'lucide-react';

// ─── Category Config ─────────────────────────────────────────

const CATEGORY_ICONS: Record<string, string> = {
  fiscalita: '💰',
  permessi: '📋',
  assicurazioni: '🏥',
  pensione: '🏦',
  trasporti: '🚗',
  residenza: '🏠',
  lavoro: '💼',
  famiglia: '👨‍👩‍👧‍👦',
  generale: '💬',
};

const CATEGORY_COLORS: Record<string, string> = {
  fiscalita: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  permessi: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  assicurazioni: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
  pensione: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  trasporti: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  residenza: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
  lavoro: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
  famiglia: 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400',
  generale: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
};

// ─── Time formatting ─────────────────────────────────────────

function timeAgo(date: Date | null): string {
  if (!date) return '';
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'adesso';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min fa`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h fa`;
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)}g fa`;
  return date.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
}

// ─── Component ───────────────────────────────────────────────

const CommunityForum: React.FC = () => {
  const { t } = useTranslation();
  const { user, signIn } = useAuth();

  // State
  const [questions, setQuestions] = useState<ForumQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<ForumCategory | ''>('');
  const [sortBy, setSortBy] = useState<'recent' | 'popular'>('recent');

  // Detail view
  const [selectedQuestion, setSelectedQuestion] = useState<ForumQuestion | null>(null);
  const [answers, setAnswers] = useState<ForumAnswer[]>([]);
  const [loadingAnswers, setLoadingAnswers] = useState(false);

  // New question form
  const [showNewForm, setShowNewForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [newCategory, setNewCategory] = useState<ForumCategory>('generale');
  const [newTags, setNewTags] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // New answer
  const [newAnswer, setNewAnswer] = useState('');
  const [submittingAnswer, setSubmittingAnswer] = useState(false);

  // ─── Load questions ──────────────────────────────────────

  const loadQuestions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = await getQuestions({
        category: selectedCategory || undefined,
        sortBy,
      });
      setQuestions(qs);
    } catch (e) {
      console.warn('Failed to load questions:', e);
      setError(t('forum.loadError') || 'Errore nel caricamento delle domande');
    } finally {
      setLoading(false);
    }
  }, [selectedCategory, sortBy, t]);

  useEffect(() => {
    loadQuestions();
  }, [loadQuestions]);

  // ─── Load answers for a question ─────────────────────────

  const openQuestion = useCallback(async (q: ForumQuestion) => {
    setSelectedQuestion(q);
    setLoadingAnswers(true);
    try {
      const ans = await getAnswers(q.id);
      setAnswers(ans);
    } catch (e) {
      console.warn('Failed to load answers:', e);
    } finally {
      setLoadingAnswers(false);
    }
    Analytics.trackUIInteraction('forum', 'question', 'view', q.id);
  }, []);

  // ─── Create question ─────────────────────────────────────

  const handleCreateQuestion = useCallback(async () => {
    if (!user || !newTitle.trim() || !newBody.trim()) return;
    setSubmitting(true);
    try {
      await createQuestion({
        title: newTitle.trim(),
        body: newBody.trim(),
        authorId: user.uid,
        authorName: getUserDisplayName(user),
        authorPhoto: getUserPhotoURL(user),
        category: newCategory,
        tags: newTags.split(',').map(t => t.trim()).filter(Boolean),
      });
      setNewTitle('');
      setNewBody('');
      setNewTags('');
      setShowNewForm(false);
      unlockAchievement('forum_first_question');
      await loadQuestions();
      Analytics.trackUIInteraction('forum', 'question', 'create', newCategory);
    } catch (e) {
      console.warn('Failed to create question:', e);
    } finally {
      setSubmitting(false);
    }
  }, [user, newTitle, newBody, newCategory, newTags, loadQuestions]);

  // ─── Create answer ───────────────────────────────────────

  const handleCreateAnswer = useCallback(async () => {
    if (!user || !selectedQuestion || !newAnswer.trim()) return;
    setSubmittingAnswer(true);
    try {
      await createAnswer({
        questionId: selectedQuestion.id,
        body: newAnswer.trim(),
        authorId: user.uid,
        authorName: getUserDisplayName(user),
        authorPhoto: getUserPhotoURL(user),
      });
      setNewAnswer('');
      // Reload answers
      const ans = await getAnswers(selectedQuestion.id);
      setAnswers(ans);
      // Update answer count locally
      setSelectedQuestion(prev => prev ? { ...prev, answerCount: prev.answerCount + 1 } : null);
      unlockAchievement('forum_first_answer');
      Analytics.trackUIInteraction('forum', 'answer', 'create', selectedQuestion.id);
    } catch (e) {
      console.warn('Failed to create answer:', e);
    } finally {
      setSubmittingAnswer(false);
    }
  }, [user, selectedQuestion, newAnswer]);

  // ─── Upvote ──────────────────────────────────────────────

  const handleUpvoteQuestion = useCallback(async (qId: string) => {
    if (!user) return;
    try {
      await upvoteQuestion(qId, user.uid);
      setQuestions(prev =>
        prev.map(q => {
          if (q.id !== qId) return q;
          const already = q.upvotedBy.includes(user.uid);
          return {
            ...q,
            upvotes: already ? q.upvotes - 1 : q.upvotes + 1,
            upvotedBy: already ? q.upvotedBy.filter(id => id !== user.uid) : [...q.upvotedBy, user.uid],
          };
        })
      );
    } catch (e) {
      console.warn('Upvote failed:', e);
    }
  }, [user]);

  const handleUpvoteAnswer = useCallback(async (aId: string) => {
    if (!user) return;
    try {
      await upvoteAnswer(aId, user.uid);
      setAnswers(prev =>
        prev.map(a => {
          if (a.id !== aId) return a;
          const already = a.upvotedBy.includes(user.uid);
          return {
            ...a,
            upvotes: already ? a.upvotes - 1 : a.upvotes + 1,
            upvotedBy: already ? a.upvotedBy.filter(id => id !== user.uid) : [...a.upvotedBy, user.uid],
          };
        })
      );
    } catch (e) {
      console.warn('Upvote answer failed:', e);
    }
  }, [user]);

  // ─── Question Detail View ────────────────────────────────

  if (selectedQuestion) {
    return (
      <div className="space-y-6">
        {/* Back button */}
        <button
          onClick={() => { setSelectedQuestion(null); setAnswers([]); }}
          className="flex items-center gap-2 text-sm font-bold text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          {t('forum.backToList') || 'Torna alle domande'}
        </button>

        {/* Question card */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
          <div className="p-6">
            <div className="flex items-start gap-4">
              {/* Upvote */}
              <div className="flex flex-col items-center gap-1">
                <button
                  onClick={() => handleUpvoteQuestion(selectedQuestion.id)}
                  disabled={!user}
                  className={`p-1.5 rounded-lg transition-colors ${
                    user && selectedQuestion.upvotedBy.includes(user.uid)
                      ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400'
                      : 'text-slate-300 hover:text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-900/20'
                  } ${!user ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <ThumbsUp className="w-5 h-5" />
                </button>
                <span className="text-sm font-black text-slate-600 dark:text-slate-300">{selectedQuestion.upvotes}</span>
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <h2 className="text-xl font-black text-slate-800 dark:text-slate-100 mb-2">
                  {selectedQuestion.title}
                </h2>
                <p className="text-sm text-slate-600 dark:text-slate-500 whitespace-pre-wrap leading-relaxed">
                  {selectedQuestion.body}
                </p>
                <div className="flex flex-wrap items-center gap-2 mt-4">
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${CATEGORY_COLORS[selectedQuestion.category] || CATEGORY_COLORS.generale}`}>
                    {CATEGORY_ICONS[selectedQuestion.category]} {t(`forum.cat.${selectedQuestion.category}`)}
                  </span>
                  {selectedQuestion.tags.map(tag => (
                    <span key={tag} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-slate-100 dark:bg-slate-700 text-slate-500 rounded text-[10px]">
                      <Tag className="w-2.5 h-2.5" />{tag}
                    </span>
                  ))}
                </div>
                <div className="flex items-center gap-3 mt-3 text-xs text-slate-500">
                  {selectedQuestion.authorPhoto ? (
                    <img src={selectedQuestion.authorPhoto} alt="" className="w-5 h-5 rounded-full" referrerPolicy="no-referrer" />
                  ) : (
                    <User className="w-4 h-4" />
                  )}
                  <span className="font-bold">{selectedQuestion.authorName}</span>
                  <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{timeAgo(selectedQuestion.createdAt?.toDate() || null)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Answers */}
        <div>
          <h3 className="font-bold text-sm text-slate-600 dark:text-slate-300 mb-3 flex items-center gap-2">
            <MessageCircle className="w-4 h-4" />
            {selectedQuestion.answerCount} {t('forum.answers') || 'Risposte'}
          </h3>

          {loadingAnswers ? (
            <div className="text-center py-8 text-slate-500">
              <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
            </div>
          ) : answers.length === 0 ? (
            <div className="text-center py-8 text-slate-500 text-sm">
              {t('forum.noAnswers') || 'Nessuna risposta ancora. Sii il primo!'}
            </div>
          ) : (
            <div className="space-y-3">
              {answers.map(answer => (
                <div key={answer.id} className={`bg-white dark:bg-slate-800 rounded-xl border p-4 ${
                  answer.accepted ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50/50 dark:bg-emerald-950/10' : 'border-slate-200 dark:border-slate-700'
                }`}>
                  <div className="flex items-start gap-3">
                    <div className="flex flex-col items-center gap-1">
                      <button
                        onClick={() => handleUpvoteAnswer(answer.id)}
                        disabled={!user}
                        className={`p-1 rounded-lg transition-colors ${
                          user && answer.upvotedBy.includes(user.uid)
                            ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400'
                            : 'text-slate-300 hover:text-emerald-500'
                        } ${!user ? 'opacity-50 cursor-not-allowed' : ''}`}
                      >
                        <ThumbsUp className="w-4 h-4" />
                      </button>
                      <span className="text-xs font-bold text-slate-500">{answer.upvotes}</span>
                      {answer.accepted && <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap leading-relaxed">
                        {answer.body}
                      </p>
                      <div className="flex items-center gap-2 mt-2 text-[11px] text-slate-500">
                        {answer.authorPhoto ? (
                          <img src={answer.authorPhoto} alt="" className="w-4 h-4 rounded-full" referrerPolicy="no-referrer" />
                        ) : (
                          <User className="w-3.5 h-3.5" />
                        )}
                        <span className="font-bold">{answer.authorName}</span>
                        <span>{timeAgo(answer.createdAt?.toDate() || null)}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* New answer form */}
        {user ? (
          <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4">
            <textarea
              value={newAnswer}
              onChange={(e) => setNewAnswer(e.target.value)}
              placeholder={t('forum.answerPlaceholder') || 'Scrivi la tua risposta...'}
              className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-sm min-h-[80px] resize-y"
            />
            <div className="flex justify-end mt-2">
              <button
                onClick={handleCreateAnswer}
                disabled={submittingAnswer || !newAnswer.trim()}
                className="flex items-center gap-1.5 px-4 py-2 bg-sky-600 text-white rounded-lg text-sm font-bold hover:bg-sky-700 disabled:opacity-50 transition-colors"
              >
                {submittingAnswer ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                {t('forum.submitAnswer') || 'Rispondi'}
              </button>
            </div>
          </div>
        ) : (
          <div className="bg-slate-50 dark:bg-slate-800/50 rounded-xl p-4 text-center">
            <button onClick={signIn} className="flex items-center gap-2 mx-auto px-4 py-2 bg-sky-600 text-white rounded-lg text-sm font-bold hover:bg-sky-700 transition-colors">
              <LogIn className="w-4 h-4" />
              {t('forum.loginToAnswer') || 'Accedi per rispondere'}
            </button>
          </div>
        )}
      </div>
    );
  }

  // ─── Questions List View ─────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-br from-violet-50 to-purple-50 dark:from-violet-950/30 dark:to-purple-950/30 rounded-2xl p-6 border border-violet-200 dark:border-violet-800">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 bg-violet-100 dark:bg-violet-900/50 rounded-xl">
            <MessageSquare className="w-6 h-6 text-violet-600 dark:text-violet-400" />
          </div>
          <h2 className="text-2xl font-bold text-violet-900 dark:text-violet-100">{t('forum.title')}</h2>
        </div>
        <p className="text-violet-700 dark:text-violet-300 text-sm">{t('forum.subtitle')}</p>
      </div>

      {/* Controls */}
      <div className="flex flex-col sm:flex-row gap-3">
        {/* Category filter */}
        <div className="flex-1 flex items-center gap-2">
          <Filter className="w-4 h-4 text-slate-500 shrink-0" />
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value as ForumCategory | '')}
            className="flex-1 px-3 py-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm font-bold"
          >
            <option value="">{t('forum.allCategories') || 'Tutte le categorie'}</option>
            {FORUM_CATEGORIES.map(cat => (
              <option key={cat} value={cat}>
                {CATEGORY_ICONS[cat]} {t(`forum.cat.${cat}`)}
              </option>
            ))}
          </select>
        </div>

        {/* Sort */}
        <div className="flex gap-1 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-0.5">
          <button
            onClick={() => setSortBy('recent')}
            className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-bold transition-colors ${
              sortBy === 'recent' ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400' : 'text-slate-500'
            }`}
          >
            <Clock className="w-3 h-3" /> {t('forum.recent') || 'Recenti'}
          </button>
          <button
            onClick={() => setSortBy('popular')}
            className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-bold transition-colors ${
              sortBy === 'popular' ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400' : 'text-slate-500'
            }`}
          >
            <TrendingUp className="w-3 h-3" /> {t('forum.popular') || 'Popolari'}
          </button>
        </div>

        {/* New question button */}
        {user ? (
          <button
            onClick={() => setShowNewForm(!showNewForm)}
            className="flex items-center gap-2 px-4 py-2.5 bg-violet-600 text-white rounded-xl text-sm font-bold hover:bg-violet-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            {t('forum.askQuestion') || 'Fai una domanda'}
          </button>
        ) : (
          <button
            onClick={signIn}
            className="flex items-center gap-2 px-4 py-2.5 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-xl text-sm font-bold hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
          >
            <LogIn className="w-4 h-4" />
            {t('forum.loginToAsk') || 'Accedi per chiedere'}
          </button>
        )}
      </div>

      {/* New question form */}
      {showNewForm && user && (
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-violet-200 dark:border-violet-800 p-5 space-y-3">
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder={t('forum.titlePlaceholder') || 'Titolo della domanda...'}
            className="w-full px-4 py-2.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-sm font-bold"
            maxLength={200}
          />
          <textarea
            value={newBody}
            onChange={(e) => setNewBody(e.target.value)}
            placeholder={t('forum.bodyPlaceholder') || 'Descrivi la tua domanda in dettaglio...'}
            className="w-full px-4 py-2.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-sm min-h-[120px] resize-y"
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-500 mb-1">{t('forum.category') || 'Categoria'}</label>
              <select
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value as ForumCategory)}
                className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-sm"
              >
                {FORUM_CATEGORIES.map(cat => (
                  <option key={cat} value={cat}>{CATEGORY_ICONS[cat]} {t(`forum.cat.${cat}`)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-500 mb-1">{t('forum.tags') || 'Tag (separati da virgola)'}</label>
              <input
                type="text"
                value={newTags}
                onChange={(e) => setNewTags(e.target.value)}
                placeholder="es: tasse, permesso G, ticino"
                className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-sm"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowNewForm(false)}
              className="px-4 py-2 text-sm font-bold text-slate-500 hover:text-slate-700 transition-colors"
            >
              {t('forum.cancel') || 'Annulla'}
            </button>
            <button
              onClick={handleCreateQuestion}
              disabled={submitting || !newTitle.trim() || !newBody.trim()}
              className="flex items-center gap-1.5 px-4 py-2 bg-violet-600 text-white rounded-lg text-sm font-bold hover:bg-violet-700 disabled:opacity-50 transition-colors"
            >
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              {t('forum.submit') || 'Pubblica'}
            </button>
          </div>
        </div>
      )}

      {/* Questions list */}
      {loading ? (
        <div className="text-center py-12 text-slate-500">
          <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />
          <p className="text-sm">{t('forum.loading') || 'Caricamento domande...'}</p>
        </div>
      ) : error ? (
        <div className="text-center py-12">
          <AlertCircle className="w-8 h-8 text-amber-500 mx-auto mb-2" />
          <p className="text-sm text-amber-600">{error}</p>
          <button onClick={loadQuestions} className="mt-3 text-sm font-bold text-violet-600 hover:text-violet-700">
            {t('forum.retry') || 'Riprova'}
          </button>
        </div>
      ) : questions.length === 0 ? (
        <div className="text-center py-12 text-slate-500">
          <MessageSquare className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p className="font-bold">{t('forum.empty') || 'Nessuna domanda ancora'}</p>
          <p className="text-sm mt-1">{t('forum.emptyDesc') || 'Sii il primo a fare una domanda alla community!'}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {questions.map(q => (
            <button
              key={q.id}
              onClick={() => openQuestion(q)}
              className="w-full text-left bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4 hover:border-violet-300 dark:hover:border-violet-700 transition-colors"
            >
              <div className="flex items-start gap-3">
                {/* Upvotes */}
                <div className="flex flex-col items-center gap-0.5 pt-0.5">
                  <ThumbsUp className={`w-4 h-4 ${user && q.upvotedBy.includes(user.uid) ? 'text-emerald-500' : 'text-slate-300'}`} />
                  <span className="text-xs font-black text-slate-500">{q.upvotes}</span>
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-sm text-slate-800 dark:text-slate-200 line-clamp-2">
                    {q.title}
                  </h3>
                  <p className="text-xs text-slate-500 mt-1 line-clamp-2">
                    {q.body}
                  </p>
                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold ${CATEGORY_COLORS[q.category] || CATEGORY_COLORS.generale}`}>
                      {CATEGORY_ICONS[q.category]} {t(`forum.cat.${q.category}`)}
                    </span>
                    {q.tags.slice(0, 3).map(tag => (
                      <span key={tag} className="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-700 text-slate-500 rounded text-[9px]">
                        {tag}
                      </span>
                    ))}
                    <span className="flex items-center gap-1 text-[10px] text-slate-500 ml-auto">
                      <MessageCircle className="w-3 h-3" /> {q.answerCount}
                      <span className="mx-1">·</span>
                      <Clock className="w-3 h-3" /> {timeAgo(q.createdAt?.toDate() || null)}
                    </span>
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default CommunityForum;
