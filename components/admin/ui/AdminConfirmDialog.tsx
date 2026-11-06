import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { AdminButton } from './AdminButton';

export interface AdminConfirmationDetails {
  title: string;
  what: ReactNode;
  workflowFile?: string;
  impact: string;
  input: string;
  expectedDuration: string;
  confirmLabel: string;
  confirmVariant?: 'primary' | 'danger';
}

interface AdminConfirmContextValue {
  requestConfirmation: (details: AdminConfirmationDetails) => Promise<boolean>;
}

const defaultContext: AdminConfirmContextValue = {
  requestConfirmation: async () => false,
};

const AdminConfirmContext = createContext<AdminConfirmContextValue>(defaultContext);

/** Native dialog confirmation shared by workflow, editorial and outreach actions. */
export function AdminConfirmProvider({ children }: { children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const resolverRef = useRef<((confirmed: boolean) => void) | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const [pending, setPending] = useState<AdminConfirmationDetails | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    const resolver = resolverRef.current;
    resolverRef.current = null;
    const trigger = triggerRef.current;
    triggerRef.current = null;
    const dialog = dialogRef.current;
    if (dialog?.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
    setPending(null);
    resolver?.(confirmed);
    window.setTimeout(() => trigger?.focus(), 0);
  }, []);

  const requestConfirmation = useCallback((details: AdminConfirmationDetails) => new Promise<boolean>((resolve) => {
    if (resolverRef.current) resolverRef.current(false);
    resolverRef.current = resolve;
    triggerRef.current = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setPending(details);
  }), []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!pending || !dialog) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    window.setTimeout(() => cancelRef.current?.focus(), 0);
  }, [pending]);

  return (
    <AdminConfirmContext.Provider value={{ requestConfirmation }}>
      {children}
      <dialog
        ref={dialogRef}
        aria-labelledby="admin-confirm-title"
        aria-describedby="admin-confirm-description"
        className="admin-confirm-dialog w-[min(100%-2rem,34rem)] rounded-stripe border border-edge bg-surface p-0 text-body shadow-stripe-lg backdrop:bg-heading/50"
        onCancel={(event) => { event.preventDefault(); settle(false); }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            settle(false);
          }
        }}
      >
        {pending && (
          <div className="space-y-5 p-5 sm:p-6">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-warning-subtle text-warning" aria-hidden="true">
                <AlertTriangle size={18} />
              </span>
              <div>
                <h2 id="admin-confirm-title" className="font-display text-xl font-medium text-heading">{pending.title}</h2>
                <p id="admin-confirm-description" className="mt-1 text-sm leading-6 text-subtle">{pending.what}</p>
              </div>
            </div>
            <dl className="grid gap-3 rounded-stripe border border-edge bg-surface-alt p-4 text-sm sm:grid-cols-[auto_1fr]">
              {pending.workflowFile && <><dt className="font-semibold text-heading">Workflow</dt><dd><code className="break-all text-xs text-muted">{pending.workflowFile}</code></dd></>}
              <dt className="font-semibold text-heading">Impatto</dt><dd>{pending.impact}</dd>
              <dt className="font-semibold text-heading">Input</dt><dd className="break-words font-mono text-xs">{pending.input || 'nessuno'}</dd>
              <dt className="font-semibold text-heading">Durata attesa</dt><dd>{pending.expectedDuration}</dd>
            </dl>
            <div className="flex flex-wrap justify-end gap-2">
              <button ref={cancelRef} type="button" onClick={() => settle(false)} className="inline-flex min-h-10 items-center justify-center rounded-stripe border border-edge bg-surface px-3.5 py-2 text-sm font-medium text-body transition-colors hover:border-accent hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2">Annulla</button>
              <AdminButton variant={pending.confirmVariant || 'primary'} onClick={() => settle(true)}>{pending.confirmLabel}</AdminButton>
            </div>
          </div>
        )}
      </dialog>
    </AdminConfirmContext.Provider>
  );
}

export function useAdminConfirm(): AdminConfirmContextValue {
  return useContext(AdminConfirmContext);
}
