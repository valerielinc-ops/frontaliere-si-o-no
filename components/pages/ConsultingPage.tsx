/**
 * ConsultingPage — Personalized consulting booking page
 * 
 * Two tiers:
 * - Base (€49): 30-min video call, general fiscal overview
 * - Premium (€99): 60-min video call, personalized simulation + written report
 * 
 * Booking via Calendly embed link. Revenue: €49-99/session.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Calendar, CheckCircle, Clock, FileText, Video, Star, ArrowRight, Shield, Users, Euro, ExternalLink } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';

const CALENDLY_BASE = 'https://calendly.com/frontaliereticino/30min';
const CALENDLY_PREMIUM = 'https://calendly.com/frontaliereticino/consulenza-premium';

/** Load Calendly widget script once */
let calendlyScriptLoaded = false;
function ensureCalendlyScript(): Promise<void> {
 if (calendlyScriptLoaded) return Promise.resolve();
 return new Promise((resolve) => {
 if (document.querySelector('script[src*="assets.calendly.com"]')) {
 calendlyScriptLoaded = true;
 resolve();
 return;
 }
 const s = document.createElement('script');
 s.src = 'https://assets.calendly.com/assets/external/widget.js';
 s.async = true;
 s.onload = () => { calendlyScriptLoaded = true; resolve(); };
 document.head.appendChild(s);
 });
}

interface ConsultingTier {
 id: 'base' | 'premium';
 price: number;
 duration: number;
 calendlyUrl: string;
 color: string;
 icon: React.ReactNode;
 popular?: boolean;
}

const TIERS: ConsultingTier[] = [
 {
 id: 'base',
 price: 49,
 duration: 30,
 calendlyUrl: CALENDLY_BASE,
 color: 'blue',
 icon: <Video className="w-6 h-6" />,
 },
 {
 id: 'premium',
 price: 99,
 duration: 60,
 calendlyUrl: CALENDLY_PREMIUM,
 color: 'amber',
 icon: <Star className="w-6 h-6" />,
 popular: true,
 },
];

const ConsultingPage: React.FC = () => {
 const { t } = useTranslation();
 const [selectedTier, setSelectedTier] = useState<'base' | 'premium' | null>(null);
 const calendlyRef = useRef<HTMLDivElement>(null);

 // Load Calendly script & scroll to widget when a tier is selected
 useEffect(() => {
 if (!selectedTier) return;
 ensureCalendlyScript().then(() => {
 // Small delay to let the DOM render the container
 setTimeout(() => {
 calendlyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
 }, 200);
 });
 }, [selectedTier]);

 const handleBooking = (tier: ConsultingTier) => {
 Analytics.trackExternalLink(tier.calendlyUrl, `consulting_${tier.id}`);
 Analytics.trackSelectContent('consulting_booking', tier.id);
 setSelectedTier(tier.id);
 };

 return (
 <div className="space-y-8">
 {/* Header */}
 <div className="text-center space-y-3">
 <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-accent-subtle text-accent rounded-full text-xs font-medium">
 <Calendar className="w-4 h-4" />
 {t('consulting.badge')}
 </div>
 <h1 className="text-2xl sm:text-3xl font-bold text-heading">
 {t('consulting.title')}
 </h1>
 <p className="text-subtle max-w-2xl mx-auto text-lg">
 {t('consulting.subtitle')}
 </p>
 </div>

 {/* Trust bar */}
 <div className="flex flex-wrap items-center justify-center gap-6 text-sm text-muted">
 <span className="inline-flex items-center gap-1.5">
 <Shield className="w-4 h-4 text-success" />
 {t('consulting.trust.secure')}
 </span>
 <span className="inline-flex items-center gap-1.5">
 <Users className="w-4 h-4 text-link" />
 {t('consulting.trust.experts')}
 </span>
 <span className="inline-flex items-center gap-1.5">
 <CheckCircle className="w-4 h-4 text-warning" />
 {t('consulting.trust.satisfaction')}
 </span>
 </div>

 {/* Pricing cards */}
 <div className="grid md:grid-cols-2 gap-6 max-w-3xl mx-auto">
 {TIERS.map((tier) => {
 const isSelected = selectedTier === tier.id;
 const features = (t(`consulting.${tier.id}.features`) || '').split('|').filter(Boolean);

 return (
 <div
 key={tier.id}
 onClick={() => setSelectedTier(tier.id)}
 className={`relative rounded-2xl border-2 p-4 sm:p-6 cursor-pointer transition-colors duration-200 ${
 tier.popular
 ? 'border-warning-border bg-warning-subtle'
 : 'border-edge bg-surface/50'
 } ${isSelected ? 'ring-2 ring-accent ring-offset-2 ring-offset-surface-alt scale-[1.02]' : 'hover:border-edge'}`}
 >
 {tier.popular && (
 <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 bg-warning text-warning text-xs font-bold rounded-full">
 {t('consulting.popular')}
 </div>
 )}

 <div className="space-y-4">
 {/* Header */}
 <div className="flex items-center gap-3">
 <div className={`p-2 rounded-xl ${
 tier.popular
 ? 'bg-warning-subtle text-warning'
 : 'bg-accent-subtle text-accent'
 }`}>
 {tier.icon}
 </div>
 <div>
 <h3 className="font-bold text-lg text-heading">
 {t(`consulting.${tier.id}.name`)}
 </h3>
 <span className="text-sm text-muted inline-flex items-center gap-1">
 <Clock className="w-3.5 h-3.5" />
 {tier.duration} min
 </span>
 </div>
 </div>

 {/* Price */}
 <div className="flex items-baseline gap-1">
 <span className="text-3xl sm:text-4xl font-bold text-heading">€{tier.price}</span>
 <span className="text-muted text-sm">/{t('consulting.perSession')}</span>
 </div>

 {/* Description */}
 <p className="text-sm text-subtle">
 {t(`consulting.${tier.id}.description`)}
 </p>

 {/* Features */}
 <ul className="space-y-2.5">
 {features.map((feature, i) => (
 <li key={i} className="flex items-start gap-2 text-sm">
 <CheckCircle className={`w-4 h-4 mt-0.5 flex-shrink-0 ${
 tier.popular
 ? 'text-warning'
 : 'text-link'
 }`} />
 <span className="text-body">{feature.trim()}</span>
 </li>
 ))}
 </ul>

 {/* CTA */}
 <button
 onClick={(e) => { e.stopPropagation(); handleBooking(tier); }}
 className={`w-full py-3 px-4 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-colors ${
 tier.popular
 ? 'bg-warning-strong hover:bg-warning-strong-hover text-on-accent'
 : 'bg-accent hover:bg-accent-hover text-on-accent'
 }`}
 >
 <Calendar className="w-4 h-4" />
 {t('consulting.book')}
 <ArrowRight className="w-4 h-4" />
 </button>
 </div>
 </div>
 );
 })}
 </div>

 {/* How it works */}
 <div className="max-w-3xl mx-auto">
 <h2 className="text-xl font-bold text-heading text-center mb-6">
 {t('consulting.howItWorks')}
 </h2>
 <div className="grid sm:grid-cols-3 gap-4">
 {[
 { icon: <Calendar className="w-5 h-5" />, step: 1, key: 'step1' },
 { icon: <Video className="w-5 h-5" />, step: 2, key: 'step2' },
 { icon: <FileText className="w-5 h-5" />, step: 3, key: 'step3' },
 ].map(({ icon, step, key }) => (
 <div key={step} className="text-center p-4 rounded-xl bg-surface-alt/50 space-y-2">
 <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-accent-subtle text-accent font-bold text-sm">
 {step}
 </div>
 <div className="flex justify-center text-subtle">
 {icon}
 </div>
 <h3 className="font-semibold text-sm text-heading">
 {t(`consulting.${key}.title`)}
 </h3>
 <p className="text-sm text-muted">
 {t(`consulting.${key}.desc`)}
 </p>
 </div>
 ))}
 </div>
 </div>

 {/* Topics */}
 <div className="max-w-3xl mx-auto bg-surface-alt/30 rounded-2xl p-4 sm:p-6 space-y-4">
 <h2 className="text-lg font-bold text-heading">
 {t('consulting.topicsTitle')}
 </h2>
 <div className="grid sm:grid-cols-2 gap-3">
 {(t('consulting.topicsList') || '').split('|').filter(Boolean).map((topic, i) => (
 <div key={i} className="flex items-center gap-2 text-sm text-body">
 <CheckCircle className="w-4 h-4 text-success flex-shrink-0" />
 {topic.trim()}
 </div>
 ))}
 </div>
 </div>

 {/* Calendly inline widget */}
 {selectedTier && (
 <div ref={calendlyRef} className="max-w-3xl mx-auto space-y-4">
 <div className="flex items-center justify-between">
 <h2 className="text-xl font-bold text-heading flex items-center gap-2">
 <Calendar className="w-5 h-5 text-link" />
 {t(`consulting.${selectedTier}.name`)} — {t('consulting.book')}
 </h2>
 <button
 onClick={() => setSelectedTier(null)}
 className="text-sm text-muted hover:text-strong underline"
 aria-label={t('consulting.changeSelection')}
 >
 {t('consulting.changeSelection')}
 </button>
 </div>
 <div
 className="calendly-inline-widget rounded-2xl overflow-hidden border border-edge"
 data-url={selectedTier === 'premium' ? CALENDLY_PREMIUM : CALENDLY_BASE}
 style={{ minWidth: '320px', height: '700px' }}
 />
 </div>
 )}

 {/* Disclaimer */}
 <p className="text-center text-xs text-muted max-w-2xl mx-auto">
 {t('consulting.disclaimer')}
 </p>
 </div>
 );
};

export default ConsultingPage;
