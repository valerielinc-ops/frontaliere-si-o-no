import React, { useState, useEffect } from 'react';
import { Shield, Settings, X } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import {
 hasConsent,
 acceptAll,
 rejectAll,
 updateConsent,
 getConsent,
} from '@/services/consentService';
import { buildPath } from '@/services/router';
import { requestSlot, releaseSlot, isActive, subscribe, POPUP_PRIORITY } from '@/services/popupQueue';

const CookieBanner: React.FC = () => {
 const { t } = useTranslation();
 const [visible, setVisible] = useState(false);
 const [showDetails, setShowDetails] = useState(false);
 const [analyticsOn, setAnalyticsOn] = useState(false);
 const [advertisingOn, setAdvertisingOn] = useState(false);
 const [queueActive, setQueueActive] = useState(false);

 useEffect(() => {
 // Show banner only if user hasn't made a choice yet
 if (!hasConsent()) {
 // Small delay so banner doesn't compete with LCP
 const timer = setTimeout(() => {
 setVisible(true);
 requestSlot('cookie-banner', POPUP_PRIORITY.COOKIE_CONSENT);
 }, 1500);
 return () => clearTimeout(timer);
 }
 }, []);

 useEffect(() => {
 const unsub = subscribe(() => setQueueActive(isActive('cookie-banner')));
 setQueueActive(isActive('cookie-banner'));
 return () => {
 unsub();
 releaseSlot('cookie-banner');
 };
 }, []);

 if (!visible || !queueActive) return null;

 const handleAcceptAll = () => {
 acceptAll();
 releaseSlot('cookie-banner');
 setVisible(false);
 };

 const handleRejectAll = () => {
 rejectAll();
 releaseSlot('cookie-banner');
 setVisible(false);
 };

 const handleSaveCustom = () => {
 updateConsent({ analytics: analyticsOn, advertising: advertisingOn });
 releaseSlot('cookie-banner');
 setVisible(false);
 };

 const privacyHref = buildPath({ activeTab: 'privacy' });

 return (
 <div
 role="dialog"
 aria-label={t('consent.title')}
 className="fixed bottom-0 left-0 right-0 z-[9999] p-3 sm:p-4 animate-slide-up"
 >
 <div className="max-w-2xl mx-auto bg-surface rounded-2xl shadow-2xl border border-edge p-4 sm:p-6">
 {/* Header */}
 <div className="flex items-start gap-3 mb-3">
 <Shield className="w-5 h-5 text-link flex-shrink-0 mt-0.5" />
 <div className="flex-1 min-w-0">
 <h3 className="text-sm font-bold text-heading">
 {t('consent.title')}
 </h3>
 <p className="text-sm text-subtle mt-1 leading-relaxed">
 {t('consent.description')}{' '}
 <a
 href={privacyHref}
 className="text-link underline hover:text-accent"
 >
 {t('consent.privacyLink')}
 </a>
 </p>
 </div>
 </div>

 {/* Detail panel (expanded) */}
 {showDetails && (
 <div className="mb-4 space-y-3 bg-surface-alt rounded-xl p-3">
 {/* Essential — always on */}
 <label className="flex items-center justify-between gap-2">
 <span className="text-xs text-body font-medium">
 {t('consent.essential')}
 </span>
 <span className="text-xs text-success font-medium">
 {t('consent.alwaysOn')}
 </span>
 </label>

 {/* Analytics */}
 <label className="flex items-center justify-between gap-2 cursor-pointer">
 <span className="text-xs text-body">
 {t('consent.analytics')}
 </span>
 <button
 type="button"
 role="switch"
 aria-checked={analyticsOn}
 aria-label={t('consent.analytics')}
 onClick={() => setAnalyticsOn(!analyticsOn)}
 className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full transition-colors ${
 analyticsOn ? 'bg-accent-strong' : 'bg-surface-raised'
 }`}
 >
 <span
 className={`inline-block h-4 w-4 transform rounded-full bg-surface shadow transition-transform mt-0.5 ${
 analyticsOn ? 'translate-x-4 ml-0.5' : 'translate-x-0.5'
 }`}
 />
 </button>
 </label>

 {/* Advertising */}
 <label className="flex items-center justify-between gap-2 cursor-pointer">
 <span className="text-xs text-body">
 {t('consent.advertising')}
 </span>
 <button
 type="button"
 role="switch"
 aria-checked={advertisingOn}
 aria-label={t('consent.advertising')}
 onClick={() => setAdvertisingOn(!advertisingOn)}
 className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full transition-colors ${
 advertisingOn ? 'bg-accent-strong' : 'bg-surface-raised'
 }`}
 >
 <span
 className={`inline-block h-4 w-4 transform rounded-full bg-surface shadow transition-transform mt-0.5 ${
 advertisingOn ? 'translate-x-4 ml-0.5' : 'translate-x-0.5'
 }`}
 />
 </button>
 </label>

 <button
 onClick={handleSaveCustom}
 className="w-full text-xs font-medium py-2 rounded-lg bg-accent hover:bg-accent-hover text-on-accent transition-colors"
 >
 {t('consent.savePreferences')}
 </button>
 </div>
 )}

 {/* Action buttons */}
 <div className="flex flex-col sm:flex-row gap-2">
 <button
 onClick={handleAcceptAll}
 className="flex-1 text-xs font-medium py-2.5 px-4 rounded-lg bg-accent hover:bg-accent-hover text-on-accent transition-colors"
 >
 {t('consent.acceptAll')}
 </button>
 <button
 onClick={handleRejectAll}
 className="flex-1 text-xs font-medium py-2.5 px-4 rounded-lg bg-surface-raised text-body hover:bg-surface-raised transition-colors"
 >
 {t('consent.rejectAll')}
 </button>
 {!showDetails && (
 <button
 onClick={() => setShowDetails(true)}
 className="flex-1 text-xs font-medium py-2.5 px-4 rounded-lg border border-edge text-subtle hover:bg-surface-raised transition-colors inline-flex items-center justify-center gap-1"
 aria-label={t('consent.customize')}
 >
 <Settings className="w-3.5 h-3.5" />
 {t('consent.customize')}
 </button>
 )}
 </div>
 </div>
 </div>
 );
};

export default CookieBanner;
