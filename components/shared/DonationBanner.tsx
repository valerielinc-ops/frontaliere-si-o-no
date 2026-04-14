/**
 * DonationBanner — Subtle "Offrici un caffè" donation prompt
 * 
 * Shows a small, non-intrusive donation prompt. Can be placed in the
 * footer or contact page. Dismissable and remembers dismissal.
 */

import React from 'react';
import { Coffee, Heart } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';

interface DonationBannerProps {
  /** 'inline' for footer/page use, 'floating' for corner toast */
  variant?: 'inline' | 'floating';
}

const DonationBanner: React.FC<DonationBannerProps> = ({ variant = 'inline' }) => {
  const { t } = useTranslation();

  const handleClick = () => {
    Analytics.trackExternalLink('https://www.buymeacoffee.com/frontaliereticino', 'donation_banner');
    Analytics.trackSelectContent('donation', 'buymeacoffee');
  };

  if (variant === 'inline') {
    return (
      <div className="flex items-center gap-3 p-3 bg-warning-subtle/50 rounded-xl border border-amber-200/50 dark:border-amber-800/30">
        <Coffee className="w-5 h-5 text-warning flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs text-body">
            {t('donation.message')}
          </p>
        </div>
        <a
          href="https://www.buymeacoffee.com/frontaliereticino"
          target="_blank"
          rel="noopener noreferrer"
          onClick={handleClick}
          className="flex-shrink-0 inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-warning bg-warning-subtle hover:bg-amber-200 dark:hover:bg-amber-900/60 rounded-lg transition-colors border border-amber-200/50 dark:border-amber-700/50"
        >
          <Heart className="w-3 h-3" />
          {t('donation.button')}
        </a>
      </div>
    );
  }

  return null;
};

export default DonationBanner;
