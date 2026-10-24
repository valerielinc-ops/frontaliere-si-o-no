import React from 'react';
import { useTranslation, useTranslationNamespace, type TranslationNamespace } from '@/services/i18n';

/**
 * Renders `children` once an on-demand translation namespace is loaded
 * (services/i18n.ts — `services/locales/<locale>-ns-<name>.ts`), and a loading
 * status before that, so a lazy page never paints raw keys. For pages whose
 * whole body reads the namespace; a component that needs only a few of its
 * keys calls useTranslationNamespace() itself.
 */
export function TranslationNamespaceGate({ namespace, children }: { namespace: TranslationNamespace; children: React.ReactNode }): React.ReactElement {
  const { t } = useTranslation();
  const ready = useTranslationNamespace(namespace);
  if (!ready) {
    return (
      <div className="min-h-[50vh] flex items-center justify-center text-muted" role="status" aria-live="polite" data-testid={`ns-loading-${namespace}`}>
        {t('common.loading')}
      </div>
    );
  }
  return <>{children}</>;
}
