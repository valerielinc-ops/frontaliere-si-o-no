/**
 * ToolOfTheWeek — Rotating weekly tool highlight with social sharing
 *
 * Deterministically selects a"tool of the week" based on the current week number.
 * Displays the tool with description, CTA, and pre-formatted social share text
 * for WhatsApp, Twitter, Facebook, and copy-to-clipboard.
 */

import React, { useState, useCallback, useMemo } from 'react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { useNavigationOptional } from '@/services/NavigationContext';
import type { ActiveTab } from '@/services/router';
import {
 Star, ArrowRight, Copy, Check, MessageCircle, Twitter,
 Facebook, Sparkles, Share2, ChevronDown, ChevronUp
} from 'lucide-react';

// ─── Tool definitions ───────────────────────────────────────────────────

interface ToolDef {
 id: string;
 icon: string;
 slug: string; // Italian URL slug (for share links)
 tab: ActiveTab; // Navigation target tab
 subTab?: string; // Navigation target sub-tab
 titleKey: string; // i18n key for title
 descKey: string; // i18n key for description
 color: string; // Tailwind gradient
}

const ALL_TOOLS: ToolDef[] = [
 { id: 'calculator', icon: '🧮', slug: '/calcola-stipendio', tab: 'calculator', subTab: 'salary', titleKey: 'toolOfWeek.tools.calculator', descKey: 'toolOfWeek.tools.calculatorDesc', color: 'from-stripe-500 to-stripe-600' },
 { id: 'exchange', icon: '💱', slug: '/comparatori/cambio-valuta', tab: 'confronti', subTab: 'exchange', titleKey: 'toolOfWeek.tools.exchange', descKey: 'toolOfWeek.tools.exchangeDesc', color: 'from-emerald-500 to-teal-600' },
 { id: 'health', icon: '🏥', slug: '/comparatori/casse-malati', tab: 'confronti', subTab: 'health', titleKey: 'toolOfWeek.tools.health', descKey: 'toolOfWeek.tools.healthDesc', color: 'from-red-500 to-pink-600' },
 { id: 'pension', icon: '🏦', slug: '/fisco/pensione', tab: 'fisco', subTab: 'pension', titleKey: 'toolOfWeek.tools.pension', descKey: 'toolOfWeek.tools.pensionDesc', color: 'from-teal-500 to-teal-600' },
 { id: 'permit-quiz', icon: '❓', slug: '/quiz-permesso-b-o-g', tab: 'guida', subTab: 'permit-quiz', titleKey: 'toolOfWeek.tools.permitQuiz', descKey: 'toolOfWeek.tools.permitQuizDesc', color: 'from-teal-500 to-teal-600' },
 { id: 'tredicesima', icon: '🎁', slug: '/calcolo-tredicesima-frontaliere', tab: 'calculator', subTab: 'tredicesima', titleKey: 'toolOfWeek.tools.tredicesima', descKey: 'toolOfWeek.tools.tredicesimalDesc', color: 'from-amber-500 to-orange-600' },
 { id: 'cost-of-living', icon: '🏠', slug: '/comparatori/costo-vita', tab: 'confronti', subTab: 'cost-of-living', titleKey: 'toolOfWeek.tools.costOfLiving', descKey: 'toolOfWeek.tools.costOfLivingDesc', color: 'from-sky-500 to-stripe-600' },
 { id: 'tax-return', icon: '📋', slug: '/fisco/dichiarazione', tab: 'fisco', subTab: 'tax-return', titleKey: 'toolOfWeek.tools.taxReturn', descKey: 'toolOfWeek.tools.taxReturnDesc', color: 'from-slate-500 to-slate-700' },
 { id: 'banks', icon: '🏧', slug: '/comparatori/banche', tab: 'confronti', subTab: 'banks', titleKey: 'toolOfWeek.tools.banks', descKey: 'toolOfWeek.tools.banksDesc', color: 'from-teal-500 to-emerald-600' },
 { id: 'payslip', icon: '💰', slug: '/calcola-stipendio/busta-paga', tab: 'calculator', subTab: 'payslip', titleKey: 'toolOfWeek.tools.payslip', descKey: 'toolOfWeek.tools.payslipDesc', color: 'from-green-500 to-emerald-600' },
];

function getWeekNumber(): number {
 const now = new Date();
 const start = new Date(now.getFullYear(), 0, 1);
 const diff = now.getTime() - start.getTime();
 return Math.ceil(diff / (7 * 24 * 60 * 60 * 1000));
}

// ─── Component ──────────────────────────────────────────────────────────

interface ToolOfTheWeekProps {
 /** Compact mode for embedding in dashboard */
 compact?: boolean;
 /** Navigation handler */
 onNavigate?: (path: string) => void;
}

const ToolOfTheWeek: React.FC<ToolOfTheWeekProps> = ({ compact = false, onNavigate }) => {
 const { t } = useTranslation();
 const nav = useNavigationOptional();
 const [copied, setCopied] = useState(false);
 const [showShareOptions, setShowShareOptions] = useState(false);

 const weekNum = getWeekNumber();
 const tool = useMemo(() => ALL_TOOLS[weekNum % ALL_TOOLS.length], [weekNum]);

 const handleNavigate = useCallback(() => {
 Analytics.trackUIInteraction('tool_of_week', 'cta', 'click', tool.id);
 if (nav) {
 nav.navigateTo(tool.tab, tool.subTab);
 } else if (onNavigate) {
 onNavigate(tool.slug);
 }
 }, [nav, onNavigate, tool]);

 const toolTitle = t(tool.titleKey);
 const toolDesc = t(tool.descKey);
 const baseUrl = 'https://frontaliereticino.ch';
 const toolUrl = `${baseUrl}${tool.slug}`;

 // ─── Share text ─────────────────────────────────────────────────────

 const shareText = useMemo(() =>
 `${t('toolOfWeek.sharePrefix')} ${toolTitle}\n\n${toolDesc}\n\n${t('toolOfWeek.shareSuffix')}\n${toolUrl}`,
 [t, toolTitle, toolDesc, toolUrl]
 );

 // ─── Share handlers ─────────────────────────────────────────────────

 const shareWhatsApp = useCallback(() => {
 window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`, '_blank');
 Analytics.trackShare('whatsapp', 'tool_of_week', tool.id);
 }, [shareText, tool.id]);

 const shareTwitter = useCallback(() => {
 const text = `${t('toolOfWeek.sharePrefix')} ${toolTitle} ${t('toolOfWeek.shareSuffix')}`;
 window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(toolUrl)}`, '_blank');
 Analytics.trackShare('twitter', 'tool_of_week', tool.id);
 }, [t, toolTitle, toolUrl, tool.id]);

 const shareFacebook = useCallback(() => {
 window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(toolUrl)}`, '_blank');
 Analytics.trackShare('facebook', 'tool_of_week', tool.id);
 }, [toolUrl, tool.id]);

 const copyShareText = useCallback(async () => {
 try {
 await navigator.clipboard.writeText(shareText);
 } catch {
 const textarea = document.createElement('textarea');
 textarea.value = shareText;
 document.body.appendChild(textarea);
 textarea.select();
 document.execCommand('copy');
 document.body.removeChild(textarea);
 }
 setCopied(true);
 setTimeout(() => setCopied(false), 2000);
 Analytics.trackShare('copy_link', 'tool_of_week', tool.id);
 }, [shareText, tool.id]);

 // ─── Compact render (for dashboard embeds) ──────────────────────────

 if (compact) {
 return (
 <div className="bg-surface rounded-2xl border border-edge p-4">
 <div className="flex items-center gap-3 mb-3">
 <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${tool.color} flex items-center justify-center`}>
 <span className="text-lg">{tool.icon}</span>
 </div>
 <div className="flex-1 min-w-0">
 <div className="flex items-center gap-1 text-xs text-warning font-medium mb-0.5">
 <Star size={12} />
 {t('toolOfWeek.badge')}
 </div>
 <h4 className="font-bold text-sm text-strong truncate">
 {toolTitle}
 </h4>
 </div>
 </div>
 <p className="text-sm text-subtle mb-3 line-clamp-2">
 {toolDesc}
 </p>
 <div className="flex items-center gap-2">
 <button
 onClick={handleNavigate}
 className="flex-1 flex items-center justify-center gap-1 text-xs font-medium px-3 py-1.5 bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors"
 aria-label={t('toolOfWeek.tryIt')}
 >
 {t('toolOfWeek.tryIt')}
 <ArrowRight size={12} />
 </button>
 <button
 onClick={shareWhatsApp}
 className="p-1.5 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors"
 aria-label="WhatsApp"
 >
 <MessageCircle size={14} />
 </button>
 <button
 onClick={copyShareText}
 className="p-1.5 bg-slate-600 hover:bg-slate-700 text-white rounded-lg transition-colors"
 aria-label={copied ? t('toolOfWeek.copied') : t('toolOfWeek.copy')}
 >
 {copied ? <Check size={14} /> : <Copy size={14} />}
 </button>
 </div>
 </div>
 );
 }

 // ─── Full render ────────────────────────────────────────────────────

 return (
 <div className="max-w-2xl mx-auto">
 {/* Header */}
 <div className="text-center mb-6">
 <div className="w-14 h-14 bg-gradient-to-br from-amber-400 to-orange-500 rounded-2xl flex items-center justify-center mx-auto mb-4">
 <Sparkles size={24} className="text-white" />
 </div>
 <h2 className="text-2xl font-bold text-strong">
 {t('toolOfWeek.title')}
 </h2>
 <p className="text-subtle mt-2 text-sm">
 {t('toolOfWeek.subtitle', { week: String(weekNum) })}
 </p>
 </div>

 {/* Featured Tool Card */}
 <div className="bg-surface rounded-2xl border border-edge overflow-hidden mb-6">
 {/* Tool Header */}
 <div className={`bg-gradient-to-r ${tool.color} px-6 py-5`}>
 <div className="flex items-center gap-4">
 <div className="w-14 h-14 bg-white/20 rounded-2xl flex items-center justify-center">
 <span className="text-2xl">{tool.icon}</span>
 </div>
 <div>
 <div className="flex items-center gap-2 mb-1">
 <Star size={14} className="text-amber-300" />
 <span className="text-white/90 text-xs font-medium uppercase tracking-wide">
 {t('toolOfWeek.badge')}
 </span>
 </div>
 <h3 className="font-bold text-white text-xl">{toolTitle}</h3>
 </div>
 </div>
 </div>

 {/* Description */}
 <div className="px-6 py-5">
 <p className="text-subtle text-sm leading-relaxed">
 {toolDesc}
 </p>

 {/* CTA */}
 <button
 onClick={handleNavigate}
 className="mt-4 w-full flex items-center justify-center gap-2 px-4 py-3 bg-accent hover:bg-accent-hover text-white font-semibold rounded-xl transition-colors"
 aria-label={t('toolOfWeek.tryIt')}
 >
 {t('toolOfWeek.tryIt')}
 <ArrowRight size={18} />
 </button>
 </div>
 </div>

 {/* Share Section */}
 <div className="bg-surface rounded-2xl border border-edge p-6">
 <button
 onClick={() => setShowShareOptions(!showShareOptions)}
 className="w-full flex items-center justify-between"
 aria-label={t('toolOfWeek.shareTitle')}
 >
 <h3 className="font-bold text-strong flex items-center gap-2">
 <Share2 size={18} className="text-stripe-500" />
 {t('toolOfWeek.shareTitle')}
 </h3>
 {showShareOptions ? <ChevronUp size={16} className="text-muted" /> : <ChevronDown size={16} className="text-muted" />}
 </button>

 {showShareOptions && (
 <div className="mt-4 space-y-3">
 {/* Pre-formatted share text */}
 <div className="bg-surface-alt rounded-xl p-4">
 <p className="text-sm text-subtle whitespace-pre-line">
 {shareText}
 </p>
 </div>

 {/* Share buttons */}
 <div className="flex flex-wrap gap-2">
 <button
 onClick={shareWhatsApp}
 className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-xl transition-colors"
 aria-label="WhatsApp"
 >
 <MessageCircle size={16} />
 WhatsApp
 </button>
 <button
 onClick={shareTwitter}
 className="flex items-center gap-2 px-4 py-2 bg-sky-500 hover:bg-sky-600 text-white text-sm font-medium rounded-xl transition-colors"
 aria-label="Twitter/X"
 >
 <Twitter size={16} />
 Twitter
 </button>
 <button
 onClick={shareFacebook}
 className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-xl transition-colors"
 aria-label="Facebook"
 >
 <Facebook size={16} />
 Facebook
 </button>
 <button
 onClick={copyShareText}
 className="flex items-center gap-2 px-4 py-2 bg-slate-600 hover:bg-slate-700 text-white text-sm font-medium rounded-xl transition-colors"
 aria-label={copied ? t('toolOfWeek.copied') : t('toolOfWeek.copy')}
 >
 {copied ? <Check size={16} /> : <Copy size={16} />}
 {copied ? t('toolOfWeek.copied') : t('toolOfWeek.copy')}
 </button>
 </div>
 </div>
 )}
 </div>
 </div>
 );
};

export default ToolOfTheWeek;
