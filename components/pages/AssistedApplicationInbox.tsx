import { Inbox } from 'lucide-react';
import type { AssistedApplicationAutomationView } from '@/services/assistedApplicationAdminService';

const CATEGORIES: Record<string, string> = {
  processing: 'In elaborazione', interview_invite: 'Invito a colloquio', rejection: 'Esito negativo',
  documents_request: 'Documenti richiesti', question: 'Domanda del datore', assessment: 'Test',
  auto_acknowledgement: 'Candidatura ricevuta', verification: 'Verifica account', offer: 'Offerta', other: 'Messaggio',
};

export default function AssistedApplicationInbox({ automation }: { automation?: AssistedApplicationAutomationView | null }) {
  const messages = automation?.inbox || [];
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
              <p className={`text-xs ${item.forwarded === 'sent' ? 'text-success' : item.forwarded === 'failed' ? 'text-danger' : 'text-subtle'}`}>
                {item.forwarded === 'sent' ? 'Inoltrata al candidato' : item.forwarded === 'skipped' ? 'Verifica account gestita dall’automazione' : item.forwarded === 'failed' ? 'Inoltro al candidato non riuscito' : 'Inoltro non ancora confermato'}
              </p>
            </li>
          ))}
        </ul>
      )}
      {messages.length === 10 && <p className="text-xs text-subtle">Ultimi 10 messaggi ricevuti.</p>}
    </section>
  );
}
