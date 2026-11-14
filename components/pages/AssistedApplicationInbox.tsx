import { Inbox, Loader2, Send } from 'lucide-react';
import { useState } from 'react';
import type { AssistedApplicationAutomationView } from '@/services/assistedApplicationAdminService';
import { runAutomationAdminAction } from '@/services/assistedApplicationAdminService';
import { useAdminConfirm } from '@/components/admin/ui/AdminConfirmDialog';

// Why a message stayed with the automation instead of reaching the candidate.
const KEPT: Record<string, string> = {
  portal_verification: 'Verifica account gestita dall’automazione',
  portal_account_notice: 'Avviso dell’account portale gestito dall’automazione',
  application_receipt: 'Ricevuta automatica registrata, non inoltrata',
  account_verification: 'Verifica account trattenuta nella pagina',
  owner_review: 'In attesa della revisione del proprietario',
  not_candidate_action: 'Nessuna risposta richiesta al candidato',
};

const CATEGORIES: Record<string, string> = {
  processing: 'In elaborazione', interview_invite: 'Invito a colloquio', rejection: 'Esito negativo',
  documents_request: 'Documenti richiesti', question: 'Domanda del datore', assessment: 'Test',
  auto_acknowledgement: 'Candidatura ricevuta', verification: 'Verifica account', offer: 'Offerta', other: 'Messaggio',
};

export default function AssistedApplicationInbox({
  automation,
  orderId,
  user,
  onForwarded,
}: {
  automation?: AssistedApplicationAutomationView | null;
  orderId?: string;
  user?: Parameters<typeof runAutomationAdminAction>[0];
  onForwarded?: () => Promise<void> | void;
}) {
  const { requestConfirmation } = useAdminConfirm();
  const [busyMessageId, setBusyMessageId] = useState('');
  const [feedback, setFeedback] = useState('');
  const messages = automation?.inbox || [];

  const forwardAfterReview = async (item: NonNullable<AssistedApplicationAutomationView['inbox']>[number]) => {
    if (!orderId || !user || busyMessageId) return;
    const confirmed = await requestConfirmation({
      title: 'Inoltra il messaggio al candidato',
      what: `Stai autorizzando l’inoltro di «${item.subject || 'messaggio senza oggetto'}».`,
      impact: 'Il candidato riceverà il messaggio originale. Un esito incerto non verrà inviato di nuovo automaticamente.',
      input: `ordine ${orderId}, ricevuto ${item.receivedAt || 'data non disponibile'}`,
      expectedDuration: 'invio immediato',
      confirmLabel: 'Inoltra una volta',
    });
    if (!confirmed) return;
    setBusyMessageId(item.messageId);
    setFeedback('');
    try {
      const result = await runAutomationAdminAction(user, orderId, 'automationForwardInbound', { messageId: item.messageId });
      const status = String(result.forwarded || '');
      setFeedback(status === 'sent'
        ? 'Messaggio inoltrato al candidato.'
        : status === 'retry_scheduled'
          ? 'Inoltro non confermato dal provider: sono previsti solo i tentativi limitati già configurati.'
          : status === 'ambiguous'
            ? 'Esito dell’inoltro incerto: il sistema non lo invierà una seconda volta.'
            : 'Revisione registrata; nessun nuovo invio automatico è stato avviato.');
      await onForwarded?.();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Inoltro non riuscito.');
    } finally {
      setBusyMessageId('');
    }
  };

  return (
    <section className="mt-4 border-t border-edge pt-4" aria-label="Inbox della candidatura">
      <h4 className="flex items-center gap-2 text-sm font-semibold text-strong"><Inbox size={16} aria-hidden="true" />Inbox della candidatura ({messages.length})</h4>
      {automation?.candidateAlias && <p className="mt-1 break-all text-xs text-subtle">{automation.candidateAlias}</p>}
      {messages.length === 0 ? (
        <p className="mt-2 text-sm text-subtle">{automation?.candidateAlias ? 'Nessun messaggio ricevuto dal datore finora.' : 'La casella sarà disponibile quando l’automazione crea l’indirizzo della candidatura.'}</p>
      ) : (
        <ul className="mt-2 divide-y divide-edge">
          {messages.map((item, index) => (
            <li key={`${item.receivedAt}-${index}`} className="space-y-1 py-3 text-sm text-body">
              <div className="flex flex-wrap justify-between gap-2">
                <strong>{CATEGORIES[item.category] || item.category}</strong>
                <span className="text-xs text-subtle">{item.receivedAt ? new Date(item.receivedAt).toLocaleString('it-CH') : 'Data non disponibile'}</span>
              </div>
              <p className="break-words font-medium">{item.subject || 'Senza oggetto'}</p>
              <p className="break-all text-xs text-subtle">Da: {item.from || 'Mittente non disponibile'}</p>
              {item.summaryIt && <p className="max-w-prose">{item.summaryIt}</p>}
              {item.interviewWhen && <p>Colloquio: {item.interviewWhen}</p>}
              {item.ownerReviewRequired && item.ownerReviewStatus === 'pending' && (
                <div className="rounded-stripe border border-warning-border bg-warning-subtle p-3 text-sm text-warning">
                  <p>Mittente automatico e contenuto non classificato con sicurezza. Il messaggio è trattenuto per la revisione del proprietario.</p>
                  <button
                    type="button"
                    onClick={() => { void forwardAfterReview(item); }}
                    disabled={!user || !orderId || Boolean(busyMessageId)}
                    className="mt-2 inline-flex min-h-10 items-center gap-2 rounded-stripe border border-warning-border bg-surface px-3 text-sm font-semibold text-warning hover:border-accent disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busyMessageId === item.messageId ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Send size={15} aria-hidden="true" />}
                    Inoltra al candidato
                  </button>
                </div>
              )}
              <p className={`text-xs ${item.forwarded === 'sent' ? 'text-success' : item.forwarded === 'failed' ? 'text-danger' : 'text-subtle'}`}>
                {item.forwarded === 'sent' ? 'Inoltrata al candidato' : item.forwarded === 'skipped' ? (KEPT[item.forwardedReason || ''] || 'Gestita dall’automazione, non inoltrata') : item.forwarded === 'failed' ? 'Inoltro al candidato non riuscito' : 'Inoltro non ancora confermato'}
              </p>
            </li>
          ))}
        </ul>
      )}
      {feedback && <p role="status" className="mt-2 text-sm text-subtle">{feedback}</p>}
      {messages.length > 10 && <p className="text-xs text-subtle">Messaggi recenti e messaggi in attesa di revisione del proprietario.</p>}
      {messages.length === 10 && <p className="text-xs text-subtle">Ultimi 10 messaggi ricevuti.</p>}
    </section>
  );
}
