import { buildPath } from '@/services/router';
import { useTranslation } from '@/services/i18n';

/**
 * The Terms (section 6, the assisted application) and the Privacy Policy, in a
 * new tab so the payment, upload or review page stays where it is.
 */
export function AssistedApplicationLegalLinks({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  const link = 'font-semibold text-link underline underline-offset-2 hover:text-accent';
  return (
    <span className={className}>
      <a className={link} href={buildPath({ activeTab: 'terms', hash: 'candidatura-assistita' })} target="_blank" rel="noopener noreferrer">
        {t('jobBoard.assisted.termsLink')}
      </a>
      {' · '}
      <a className={link} href={buildPath({ activeTab: 'privacy' })} target="_blank" rel="noopener noreferrer">
        {t('jobBoard.assisted.privacyLink')}
      </a>
    </span>
  );
}
