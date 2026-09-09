import React, { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import type { Locale } from '@/services/i18n';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { POPUP_PRIORITY } from '@/services/popupQueue';
import BottomPromptShell from '@/components/shared/BottomPromptShell';
import CompanyFollowCta, { type CompanyFollowSurface } from './CompanyFollowCta';

const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const DISMISSED_AT_KEY = 'company_follow_popup_dismissed_at';

const POPUP_COPY: Record<Locale, { title: string; dismiss: string }> = {
  it: { title: 'Vuoi sapere quando pubblica nuovi lavori?', dismiss: 'Non ora' },
  en: { title: 'Want to know when it posts new jobs?', dismiss: 'Not now' },
  de: { title: 'Möchtest du neue Stellen dieses Unternehmens erfahren?', dismiss: 'Nicht jetzt' },
  fr: { title: 'Voulez-vous connaître ses nouvelles offres ?', dismiss: 'Pas maintenant' },
};

interface CompanyFollowPopupProps {
  company: string;
  companyKey?: string | null;
  locale: Locale;
  surface: CompanyFollowSurface;
}

function canShowPopup(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const dismissedAt = Number(window.localStorage.getItem(DISMISSED_AT_KEY) || 0);
    return !dismissedAt || Date.now() - dismissedAt >= COOLDOWN_MS;
  } catch {
    // Storage unavailable is not a reason to lose the explicit CTA; the popup
    // remains session-scoped and can be dismissed through the visible button.
    return true;
  }
}

const CompanyFollowPopup: React.FC<CompanyFollowPopupProps> = ({ company, companyKey, locale, surface }) => {
  const { t } = useTranslation();
  const [eligible, setEligible] = useState(false);
  const copy = useMemo(() => POPUP_COPY[locale] || POPUP_COPY.it, [locale]);
  const slotId = `company-follow-popup-${companyKey || company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const titleId = `${slotId}-title`;

  useEffect(() => {
    const timer = window.setTimeout(() => setEligible(canShowPopup()), 1200);
    return () => window.clearTimeout(timer);
  }, []);

  if (!eligible) return null;

  const dismiss = () => {
    try { window.localStorage.setItem(DISMISSED_AT_KEY, String(Date.now())); } catch { /* best effort */ }
    Analytics.trackUIInteraction('company_alerts', 'popup', 'company_follow', 'dismiss', undefined, 'company_follow_popup');
    setEligible(false);
  };

  return (
    <BottomPromptShell
      slotId={slotId}
      priority={POPUP_PRIORITY.COMPANY_ALERT_POPUP}
      width="md"
      ariaLabelledBy={titleId}
      onShown={() => Analytics.trackUIInteraction('company_alerts', 'popup', 'company_follow', 'impression', undefined, 'company_follow_popup')}
      onEscape={dismiss}
    >
      <div className="rounded-xl border border-edge bg-surface-raised p-4 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p id={titleId} className="text-sm font-semibold text-heading">{copy.title}</p>
            <p className="mt-1 text-xs text-muted">
              {t('jobAlert.companyFollow.hint', 'Ricevi una email quando questa azienda pubblica nuovi lavori.')}
            </p>
          </div>
          <button
            type="button"
            onClick={dismiss}
            className="rounded-md p-1 text-muted hover:text-heading"
            aria-label={copy.dismiss}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <CompanyFollowCta
          company={company}
          companyKey={companyKey}
          locale={locale}
          surface={surface}
          emailInputId={`${slotId}-email`}
        />
        <button type="button" onClick={dismiss} className="mt-2 text-xs font-semibold text-muted hover:text-heading">
          {copy.dismiss}
        </button>
      </div>
    </BottomPromptShell>
  );
};

export default CompanyFollowPopup;
