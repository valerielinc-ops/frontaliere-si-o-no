import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation, getLocale } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import {
 Languages,
 Search,
 ChevronDown,
 ChevronUp,
 Share2,
 Check,
 Sparkles,
 Volume2,
 Lightbulb,
 GraduationCap,
 PlayCircle,
 RotateCcw,
 Send,
 Plus,
} from 'lucide-react';
import { DIALECT_ENTRIES, type DialectCategory, type DialectEntry, getDialectPhraseOfDay } from '@/services/dialectService';

type Locale = 'it' | 'en' | 'de' | 'fr';

type TermField = 'phrase' | 'italian' | 'meaning' | 'example' | 'etymology';

interface CustomTermContent {
 phrase: string;
 italian: string;
 meaning: string;
 example: string;
 etymology: string;
}

interface UserPhrase {
 id: string;
 phrase: string;
 italian: string;
 meaning: string;
 createdAt: string;
}

const USER_PHRASES_KEY = 'dialect_user_phrases_v1';

const CUSTOM_TERMS: Record<string, Record<Locale, CustomTermContent>> = {
 tacatAlTram: {
 it: {
 phrase: 'Tacàt al tram',
 italian: 'Attaccato al tram / Fai in fretta',
 meaning: 'Espressione colloquiale usata per dire a qualcuno di muoversi rapidamente o di restare al passo.',
 example: 'Dai mò, tacàt al tram che semm in ritard!',
 etymology: 'Modo di dire urbano legato al vecchio lessico dei trasporti lombardo-ticinesi.',
 },
 en: {
 phrase: 'Tacàt al tram',
 italian: 'Stick to the tram / Hurry up',
 meaning: 'Colloquial expression meaning: move quickly or keep up with the group.',
 example: 'Dai mò, tacàt al tram, we are late!',
 etymology: 'Urban idiom tied to old tramway vocabulary in the Lombard-Ticino area.',
 },
 de: {
 phrase: 'Tacàt al tram',
 italian: 'Am Tram festhalten / Beeil dich',
 meaning: 'Umgangssprachlicher Ausdruck: Beeil dich oder bleib im Tempo der Gruppe.',
 example: 'Dai mò, tacàt al tram, mir sind zu spät!',
 etymology: 'Städtische Redewendung aus dem historischen Tram-Wortschatz im lombardisch-tessiner Raum.',
 },
 fr: {
 phrase: 'Tacàt al tram',
 italian: 'Accroché au tram / Dépêche-toi',
 meaning: 'Expression familière pour dire de se dépêcher ou de rester dans le rythme.',
 example: 'Dai mò, tacàt al tram, on est en retard!',
 etymology: 'Tournure urbaine liée à l’ancien vocabulaire du tram dans l’aire lombardo-tessinoise.',
 },
 },
 sbassaLaCresta: {
 it: {
 phrase: 'Sbàssa la crèsta',
 italian: 'Abbassa la cresta',
 meaning: 'Invito a essere più umili e meno arroganti in una discussione.',
 example: 'Oh, sbàssa la crèsta e parlemm con calma.',
 etymology: 'Variante lombarda di un’espressione figurata diffusa nel Nord Italia.',
 },
 en: {
 phrase: 'Sbàssa la crèsta',
 italian: 'Lower your crest',
 meaning: 'A way to tell someone to be less arrogant and more humble.',
 example: 'Hey, sbàssa la crèsta, let’s talk calmly.',
 etymology: 'Lombard variant of a figurative expression common in Northern Italy.',
 },
 de: {
 phrase: 'Sbàssa la crèsta',
 italian: 'Nimm dich zurück',
 meaning: 'Aufforderung, weniger überheblich und bescheidener zu sein.',
 example: 'Sbàssa la crèsta und red mer ruhig.',
 etymology: 'Lombardische Variante einer bildhaften Redensart aus Norditalien.',
 },
 fr: {
 phrase: 'Sbàssa la crèsta',
 italian: 'Baisse d’un ton',
 meaning: 'Invite à être moins arrogant et plus humble.',
 example: 'Sbàssa la crèsta, parlons calmement.',
 etymology: 'Variante lombarde d’une expression figurée répandue dans le nord de l’Italie.',
 },
 },
 capiNaMazza: {
 it: {
 phrase: 'Capì na màzza',
 italian: 'Non capire nulla',
 meaning: 'Espressione informale per dire che non si è capito niente di una situazione.',
 example: 'Con quel traffich in dogana, gh’ho capì na màzza.',
 etymology: 'Costruzione colloquiale condivisa tra italiano regionale e parlata lombarda.',
 },
 en: {
 phrase: 'Capì na màzza',
 italian: 'To understand nothing',
 meaning: 'Informal way to say you did not understand anything.',
 example: 'With that border traffic, I capì na màzza.',
 etymology: 'Colloquial construction shared between regional Italian and Lombard speech.',
 },
 de: {
 phrase: 'Capì na màzza',
 italian: 'Gar nichts verstehen',
 meaning: 'Umgangssprachlich: absolut nichts verstanden haben.',
 example: 'Bei dem Grenzverkehr hab ich capì na màzza.',
 etymology: 'Umgangssprachliche Form zwischen Regionalitalienisch und Lombardisch.',
 },
 fr: {
 phrase: 'Capì na màzza',
 italian: 'Ne rien comprendre',
 meaning: 'Expression familière pour dire qu’on n’a rien compris.',
 example: 'Avec ce trafic à la douane, j’ai capì na màzza.',
 etymology: 'Forme colloquiale à la frontière entre italien régional et parler lombard.',
 },
 },
 süDaCo: {
 it: {
 phrase: 'Sü da cò',
 italian: 'Su di qui / Da queste parti',
 meaning: 'Indica il territorio locale o la zona in cui ci si trova, con senso di appartenenza.',
 example: 'Sü da cò semm abituaa al frontalierato.',
 etymology: 'Locuzione deittica tipica dell’area alpina lombarda e ticinese.',
 },
 en: {
 phrase: 'Sü da cò',
 italian: 'Up here / Around here',
 meaning: 'Refers to the local area and carries a sense of community belonging.',
 example: 'Sü da cò we are used to cross-border life.',
 etymology: 'Deictic phrase typical of Alpine Lombard and Ticinese speech.',
 },
 de: {
 phrase: 'Sü da cò',
 italian: 'Hier bei uns',
 meaning: 'Bezeichnet die lokale Gegend mit einem Gefühl der Zugehörigkeit.',
 example: 'Sü da cò sind wir ans Grenzgängerleben gewöhnt.',
 etymology: 'Deiktische Wendung aus dem alpinen lombardisch-tessinischen Sprachraum.',
 },
 fr: {
 phrase: 'Sü da cò',
 italian: 'Par ici / Chez nous',
 meaning: 'Désigne la zone locale avec une nuance d’appartenance communautaire.',
 example: 'Sü da cò, on est habitués à la vie frontalière.',
 etymology: 'Expression déictique typique de l’aire alpine lombardo-tessinoise.',
 },
 },
};

const CATEGORY_COLORS: Record<DialectCategory, { bg: string; text: string }> = {
 saluti: { bg: 'bg-accent-subtle', text: 'text-accent' },
 espressioni: { bg: 'bg-warning-subtle', text: 'text-warning' },
 proverbi: { bg: 'bg-accent-subtle', text: 'text-accent' },
 cibo: { bg: 'bg-success-subtle', text: 'text-success' },
 lavoro: { bg: 'bg-info-subtle', text: 'text-info' },
 natura: { bg: 'bg-info-subtle', text: 'text-info' },
};

const CATEGORY_ICONS: Record<DialectCategory, string> = {
 saluti: '👋',
 espressioni: '💬',
 proverbi: '📜',
 cibo: '🍽️',
 lavoro: '🔧',
 natura: '🌿',
};

const TicineseDialect: React.FC = () => {
 const { t } = useTranslation();
 const [searchTerm, setSearchTerm] = useState('');
 const [selectedCategory, setSelectedCategory] = useState<DialectCategory | 'all'>('all');
 const [expandedEntry, setExpandedEntry] = useState<string | null>(null);
 const [expandCount, setExpandCount] = useState(0);
 const [copied, setCopied] = useState(false);
 const [phraseOfDayDismissed, setPhraseOfDayDismissed] = useState(false);
 const [playingKey, setPlayingKey] = useState<string | null>(null);
 const [quizState, setQuizState] = useState<{ promptKey: string; options: string[]; correct: string; selected: string | null } | null>(null);
 const [userPhrases, setUserPhrases] = useState<UserPhrase[]>([]);
 const [newPhrase, setNewPhrase] = useState({ phrase: '', italian: '', meaning: '' });
 const [savedUserPhrase, setSavedUserPhrase] = useState(false);

 const categories = useMemo<DialectCategory[]>(() => ['saluti', 'espressioni', 'proverbi', 'cibo', 'lavoro', 'natura'], []);
 const phraseOfDay = useMemo(() => getDialectPhraseOfDay(), []);
 const locale = getLocale() as Locale;
 const voiceLocale = locale === 'de' ? 'de-CH' : locale === 'fr' ? 'fr-CH' : locale === 'en' ? 'en-US' : 'it-CH';

 const tt = (key: string, fallback: string) => {
 const value = t(key);
 return value === key ? fallback : value;
 };

 const termField = (entry: DialectEntry, field: TermField): string => {
 const custom = CUSTOM_TERMS[entry.key]?.[locale] || CUSTOM_TERMS[entry.key]?.it;
 if (custom) return custom[field];
 const key = `dialect.terms.${entry.key}.${field}`;
 const value = t(key);
 return value === key ? '' : value;
 };

 useEffect(() => {
 Analytics.trackPageView('/dialetto-ticinese', 'Dialetto Ticinese');
 Analytics.trackUIInteraction('dialect', 'page', 'dialect_page', 'view');
 }, []);

 useEffect(() => {
 try {
 const raw = localStorage.getItem(USER_PHRASES_KEY);
 if (raw) setUserPhrases(JSON.parse(raw));
 } catch {
 setUserPhrases([]);
 }
 }, []);

 const filteredEntries = useMemo(() => {
 return DIALECT_ENTRIES.filter((entry) => {
 if (selectedCategory !== 'all' && entry.category !== selectedCategory) return false;
 if (!searchTerm) return true;
 const term = searchTerm.toLowerCase();
 const phrase = termField(entry, 'phrase').toLowerCase();
 const italian = termField(entry, 'italian').toLowerCase();
 const meaning = termField(entry, 'meaning').toLowerCase();
 return phrase.includes(term) || italian.includes(term) || meaning.includes(term) || entry.key.toLowerCase().includes(term);
 });
 }, [searchTerm, selectedCategory, locale]);

 const generateQuiz = () => {
 const pool = DIALECT_ENTRIES.filter(e => termField(e, 'italian') && termField(e, 'phrase'));
 if (pool.length < 4) return;
 const prompt = pool[Math.floor(Math.random() * pool.length)];
 const wrong = pool.filter(p => p.key !== prompt.key).sort(() => Math.random() - 0.5).slice(0, 3);
 const options = [prompt, ...wrong].sort(() => Math.random() - 0.5).map(e => e.key);
 setQuizState({ promptKey: prompt.key, options, correct: prompt.key, selected: null });
 Analytics.trackUIInteraction('dialect', 'quiz', 'new_quiz', 'generate');
 };

 useEffect(() => {
 generateQuiz();
 }, [locale]);

 const handleExpand = (key: string) => {
 const wasExpanded = expandedEntry === key;
 setExpandedEntry(wasExpanded ? null : key);
 Analytics.trackUIInteraction('dialect', 'entry', key, wasExpanded ? 'collapse' : 'expand');
 if (!wasExpanded) {
 const newCount = expandCount + 1;
 setExpandCount(newCount);
 if (newCount >= 5) import('@/services/gamificationService').then(m => m.unlockAchievement('dialect_explorer'));
 }
 };

 const handleShare = async (entry: DialectEntry) => {
 const phrase = termField(entry, 'phrase');
 const italian = termField(entry, 'italian');
 const text = `🇨🇭 ${tt('dialect.title', 'Dialetto Ticinese')}:"${phrase}" — ${italian}\n\nhttps://frontaliereticino.ch/dialetto-ticinese`;
 try {
 if (navigator.share) {
 await navigator.share({ title: tt('dialect.title', 'Dialetto Ticinese'), text });
 } else if (navigator.clipboard?.writeText) {
 await navigator.clipboard.writeText(text);
 }
 setCopied(true);
 setTimeout(() => setCopied(false), 1600);
 Analytics.trackShare('native', 'dialect_entry', entry.key);
 Analytics.trackUIInteraction('dialect', 'entry', entry.key, 'share');
 } catch {
 // noop
 }
 };

 const pronounce = (entry: DialectEntry) => {
 if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
 const phrase = termField(entry, 'phrase').replace(/["'!?.]/g, '');
 if (!phrase) return;
 window.speechSynthesis.cancel();
 const u = new SpeechSynthesisUtterance(phrase);
 u.lang = voiceLocale;
 u.rate = 0.9;
 u.onstart = () => setPlayingKey(entry.key);
 u.onend = () => setPlayingKey(null);
 u.onerror = () => setPlayingKey(null);
 window.speechSynthesis.speak(u);
 Analytics.trackUIInteraction('dialect', 'audio', entry.key, 'play');
 };

 const saveUserPhrase = () => {
 if (!newPhrase.phrase.trim() || !newPhrase.italian.trim() || !newPhrase.meaning.trim()) return;
 const record: UserPhrase = {
 id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
 phrase: newPhrase.phrase.trim(),
 italian: newPhrase.italian.trim(),
 meaning: newPhrase.meaning.trim(),
 createdAt: new Date().toISOString(),
 };
 const next = [record, ...userPhrases].slice(0, 12);
 setUserPhrases(next);
 localStorage.setItem(USER_PHRASES_KEY, JSON.stringify(next));
 setNewPhrase({ phrase: '', italian: '', meaning: '' });
 setSavedUserPhrase(true);
 setTimeout(() => setSavedUserPhrase(false), 1800);
 Analytics.trackUIInteraction('dialect', 'community', 'user_phrase', 'submit');
 };

 return (
 <div className="space-y-6">
 <div className="bg-warning rounded-2xl p-4 sm:p-6 text-on-accent">
 <div className="flex items-center gap-3 mb-2">
 <Languages size={28} />
 <h2 className="text-2xl font-bold font-display">{tt('dialect.title', 'Dialetto Ticinese')}</h2>
 </div>
 <p className="text-on-accent text-sm">{tt('dialect.subtitle', 'Scopri il dialetto del territorio di frontiera')}</p>
 </div>

 {!phraseOfDayDismissed && (
 <div className="bg-gradient-to-r from-warning-subtle to-warning-subtle border border-warning-border rounded-xl p-4">
 <div className="flex items-start justify-between gap-3">
 <div className="flex items-start gap-3">
 <Sparkles size={20} className="text-warning mt-0.5 shrink-0" />
 <div>
 <p className="text-xs font-semibold text-warning mb-1">{tt('dialect.phraseOfDay', 'Frase del giorno')}</p>
 <p className="text-lg font-bold text-strong italic">"{termField(phraseOfDay, 'phrase')}"</p>
 <p className="text-sm text-subtle mt-1">{termField(phraseOfDay, 'italian')}</p>
 </div>
 </div>
 <div className="flex items-center gap-1">
 <button onClick={() => pronounce(phraseOfDay)} className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-warning-subtle" aria-label={tt('dialect.playAudio', 'Ascolta')}>
 <Volume2 size={16} className={playingKey === phraseOfDay.key ? 'text-success animate-pulse' : 'text-warning'} />
 </button>
 <button onClick={() => handleShare(phraseOfDay)} className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-warning-subtle" aria-label={tt('dialect.share', 'Condividi')}>
 {copied ? <Check size={16} className="text-success" /> : <Share2 size={16} className="text-warning" />}
 </button>
 <button onClick={() => setPhraseOfDayDismissed(true)} className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-warning-subtle text-warning" aria-label={tt('common.close', 'Chiudi')}>×</button>
 </div>
 </div>
 </div>
 )}

 <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
 <div className="lg:col-span-2 bg-surface border border-edge rounded-xl p-4">
 <div className="flex items-center gap-2 mb-2">
 <Lightbulb size={18} className="text-accent" />
 <h3 className="font-semibold text-strong">{tt('dialect.historyTitle', 'Storia del dialetto')}</h3>
 </div>
 <p className="text-sm text-subtle">{tt('dialect.historyText', 'Il dialetto ticinese appartiene al gruppo lombardo occidentale, con influenze alpine, italiane e svizzere. Nella vita quotidiana convive con l’italiano standard, soprattutto nei contesti di lavoro frontaliero.')}</p>
 </div>

 <div className="bg-surface border border-edge rounded-xl p-4">
 <div className="flex items-center gap-2 mb-2">
 <GraduationCap size={18} className="text-accent" />
 <h3 className="font-semibold text-strong">{tt('dialect.quizTitle', 'Quiz')}</h3>
 </div>
 {quizState && (
 <div className="space-y-2">
 <p className="text-sm text-body">{tt('dialect.quizPrompt', 'Indovina il significato di')}: <span className="font-bold italic">"{termField({ key: quizState.promptKey, category: 'espressioni' }, 'phrase')}"</span></p>
 {quizState.options.map((opt) => {
 const isSelected = quizState.selected === opt;
 const isCorrect = quizState.selected && opt === quizState.correct;
 return (
 <button
 key={opt}
 onClick={() => {
 setQuizState(prev => prev ? { ...prev, selected: opt } : prev);
 Analytics.trackUIInteraction('dialect', 'quiz', 'answer_select', 'select', opt);
 }}
 className={`w-full text-left px-2.5 py-2 rounded-lg border text-xs font-medium transition-colors
 ${isCorrect
 ? 'border-success bg-success-subtle text-success'
 : isSelected
 ? 'border-danger bg-danger-subtle text-danger'
 : 'border-edge bg-surface text-body hover:bg-surface-alt focus:bg-surface-alt'}
 `}
 >
 {termField({ key: opt, category: 'espressioni' }, 'italian')}
 </button>
 );
 })}
 <div className="flex items-center justify-between pt-1">
 <span className="text-sm text-muted">
 {quizState.selected
 ? quizState.selected === quizState.correct
 ? tt('dialect.quizCorrect', 'Corretto!')
 : `${tt('dialect.quizWrong', 'Non esatto')}: ${termField({ key: quizState.correct, category: 'espressioni' }, 'italian')}`
 : tt('dialect.quizHint', 'Scegli una risposta')}
 </span>
 <button onClick={generateQuiz} className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
 <RotateCcw size={12} /> {tt('dialect.quizNext', 'Nuova domanda')}
 </button>
 </div>
 </div>
 )}
 </div>
 </div>

 <div className="flex flex-wrap gap-3 items-center">
 <div className="relative flex-1 min-w-[220px]">
 <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
 <input
 type="text"
 value={searchTerm}
 onChange={(e) => {
 const value = e.target.value;
 setSearchTerm(value);
 if (value.trim().length >= 2) {
 Analytics.trackSearch(value.trim());
 }
 }}
 placeholder={tt('dialect.searchPlaceholder', 'Cerca una parola o espressione...')}
 className="w-full pl-9 pr-3 py-2 rounded-lg border border-edge bg-surface-alt text-base text-strong"
 aria-label={tt('dialect.searchPlaceholder', 'Cerca una parola o espressione...')}
 />
 </div>

 <div className="flex gap-1.5 flex-wrap">
 <button
 onClick={() => {
 setSelectedCategory('all');
 Analytics.trackUIInteraction('dialect', 'filter', 'category', 'all');
 }}
 className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
 selectedCategory === 'all'
 ? 'bg-surface-raised text-heading'
 : 'bg-surface-raised text-subtle hover:bg-surface-raised'
 }`}
 >
 {tt('dialect.allCategories', 'Tutte')}
 </button>
 {categories.map((cat) => {
 const colors = CATEGORY_COLORS[cat];
 return (
 <button
 key={cat}
 onClick={() => {
 setSelectedCategory(cat);
 Analytics.trackUIInteraction('dialect', 'filter', 'category', 'select', cat);
 }}
 className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
 selectedCategory === cat
 ? `${colors.bg} ${colors.text}`
 : 'bg-surface-raised text-subtle hover:bg-surface-raised'
 }`}
 >
 {CATEGORY_ICONS[cat]} {tt(`dialect.category.${cat}`, cat)}
 </button>
 );
 })}
 </div>
 </div>

 <p className="text-sm text-muted">{filteredEntries.length} {tt('dialect.termsFound', 'espressioni trovate')}</p>

 <div className="space-y-2">
 {filteredEntries.length === 0 ? (
 <div className="text-center py-12 text-muted">
 <Languages size={48} className="mx-auto mb-3 opacity-30" />
 <p className="font-semibold">{tt('dialect.noResults', 'Nessun risultato trovato')}</p>
 </div>
 ) : (
 filteredEntries.map((entry) => {
 const colors = CATEGORY_COLORS[entry.category];
 const isExpanded = expandedEntry === entry.key;
 const phrase = termField(entry, 'phrase');
 const italian = termField(entry, 'italian');

 return (
 <div key={entry.key} className="bg-surface rounded-xl border border-edge overflow-hidden">
 <button onClick={() => handleExpand(entry.key)} className="w-full flex items-center justify-between p-4 text-left" aria-expanded={isExpanded}>
 <div className="flex items-center gap-3 min-w-0">
 <span className={`text-xs font-bold px-2 py-0.5 rounded-full shrink-0 ${colors.bg} ${colors.text}`}>
 {CATEGORY_ICONS[entry.category]} {tt(`dialect.category.${entry.category}`, entry.category)}
 </span>
 <div className="min-w-0">
 <span className="font-semibold text-sm text-strong italic block truncate">{phrase}</span>
 <span className="text-sm text-muted block truncate">{italian}</span>
 </div>
 </div>
 {isExpanded ? <ChevronUp size={16} className="text-muted shrink-0" /> : <ChevronDown size={16} className="text-muted shrink-0" />}
 </button>

 {isExpanded && (
 <div className="px-4 pb-4 text-sm text-subtle animate-fade-in border-t border-edge pt-3 space-y-3">
 <p>{termField(entry, 'meaning')}</p>
 {!!termField(entry, 'example') && (
 <div className="bg-surface-alt rounded-lg p-3 text-xs">
 <span className="font-semibold text-body">{tt('dialect.example', 'Esempio')}: </span>
 <span className="italic">{termField(entry, 'example')}</span>
 </div>
 )}
 {!!termField(entry, 'etymology') && (
 <div className="bg-accent-subtle rounded-lg p-3 text-xs">
 <span className="font-semibold text-accent">{tt('dialect.etymology', 'Etimologia')}: </span>
 <span>{termField(entry, 'etymology')}</span>
 </div>
 )}
 <div className="flex items-center gap-2">
 <button onClick={() => pronounce(entry)} className="inline-flex items-center gap-1.5 text-xs text-info hover:underline">
 <Volume2 size={14} className={playingKey === entry.key ? 'animate-pulse' : ''} /> {tt('dialect.playAudio', 'Ascolta')}
 </button>
 <button onClick={() => handleShare(entry)} className="inline-flex items-center gap-1.5 text-xs text-warning hover:underline">
 {copied ? <Check size={14} /> : <Share2 size={14} />} {tt('dialect.share', 'Condividi')}
 </button>
 </div>
 </div>
 )}
 </div>
 );
 })
 )}
 </div>

 <div className="bg-surface rounded-xl border border-edge p-4">
 <div className="flex items-center gap-2 mb-3">
 <PlayCircle size={18} className="text-accent" />
 <h3 className="font-semibold text-strong">{tt('dialect.userSectionTitle', 'Frasi proposte dagli utenti')}</h3>
 </div>

 <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-3">
 <input
 value={newPhrase.phrase}
 onChange={(e) => setNewPhrase(prev => ({ ...prev, phrase: e.target.value }))}
 placeholder={tt('dialect.userPhrase', 'Frase in dialetto')}
 aria-label={tt('dialect.userPhrase', 'Frase in dialetto')}
 className="px-3 py-2 text-xs rounded-lg border border-edge bg-surface-alt"
 />
 <input
 value={newPhrase.italian}
 onChange={(e) => setNewPhrase(prev => ({ ...prev, italian: e.target.value }))}
 placeholder={tt('dialect.userItalian', 'Traduzione')}
 aria-label={tt('dialect.userItalian', 'Traduzione')}
 className="px-3 py-2 text-xs rounded-lg border border-edge bg-surface-alt"
 />
 <input
 value={newPhrase.meaning}
 onChange={(e) => setNewPhrase(prev => ({ ...prev, meaning: e.target.value }))}
 placeholder={tt('dialect.userMeaning', 'Significato/contesto')}
 aria-label={tt('dialect.userMeaning', 'Significato/contesto')}
 className="px-3 py-2 text-xs rounded-lg border border-edge bg-surface-alt"
 />
 </div>

 <button
 onClick={saveUserPhrase}
 className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-accent-strong hover:bg-accent-strong-hover text-on-accent text-xs font-semibold"
 >
 {savedUserPhrase ? <Check size={14} /> : <Send size={14} />} {tt('dialect.userSubmit', 'Invia frase')}
 </button>

 {userPhrases.length > 0 && (
 <div className="mt-4 space-y-2">
 {userPhrases.map((p) => (
 <div key={p.id} className="rounded-lg border border-edge p-2.5">
 <p className="text-sm font-semibold italic text-strong">{p.phrase}</p>
 <p className="text-sm text-subtle">{p.italian}</p>
 <p className="text-sm text-muted">{p.meaning}</p>
 </div>
 ))}
 </div>
 )}
 </div>

 <div className="rounded-xl border border-success-border bg-success-subtle p-4 text-xs text-success">
 <div className="font-semibold flex items-center gap-2 mb-1"><Plus size={14} /> {tt('dialect.newPhrasesTitle', 'Nuove frasi aggiunte')}</div>
 <p>{tt('dialect.newPhrasesText', 'Aggiunte espressioni d’uso comune recuperate da repertori e articoli locali: “Tacàt al tram”, “Sbàssa la crèsta”, “Capì na màzza”, “Sü da cò”.')}</p>
 </div>
 </div>
 );
};

export default TicineseDialect;
