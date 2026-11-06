import { RefreshCw } from 'lucide-react';
import { useAdminWorkflow, WORKFLOW_CONTEXT_META } from '@/components/admin/AdminWorkflowProvider';
import type { WorkflowContext } from '@/components/admin/lib/adminTypes';
import { WorkflowCard } from './workflow/WorkflowCard';
import { AdminButton } from '@/components/admin/ui/AdminButton';
import { AdminSectionHeader } from '@/components/admin/ui/AdminSectionHeader';
import { relativeTime } from '@/components/admin/lib/formatters';

const contexts: WorkflowContext[] = ['content', 'seo', 'analytics'];

export default function AutomazioniSection() {
  const workflow = useAdminWorkflow();
  const latestUpdate = workflow.actions.map((action) => workflow.getWorkflowState(action.id).updatedAt).filter((value): value is string => Boolean(value)).sort().at(-1) || null;
  return (
    <div className="space-y-4">
      <AdminSectionHeader title="Automazioni" summary={`${workflow.actions.filter((action) => !action.isUtility).length} workflow disponibili · ${latestUpdate ? `aggiornato ${relativeTime(latestUpdate) || 'di recente'}` : 'non ancora aggiornato'}`} secondaryActions={<AdminButton icon={<RefreshCw size={16} aria-hidden="true" />} onClick={() => void workflow.refresh()}>Aggiorna</AdminButton>} />
      {contexts.map((context) => {
        const meta = WORKFLOW_CONTEXT_META[context];
        const actions = workflow.actions.filter((action) => action.context === context && !action.isUtility);
        return (
          <section key={context} className="space-y-3">
            <div><h2 className="text-base font-semibold text-heading">{meta.label}</h2><p className="mt-0.5 text-sm text-muted">{meta.description}</p></div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {actions.map((action) => <WorkflowCard key={action.id} workflow={action} state={workflow.getWorkflowState(action.id)} onRun={() => { void workflow.runWorkflowWithConfirmation(action.id); }} onCopy={() => { void workflow.copyAiFixRequest(action.id); }} onOpen={() => workflow.openAiFixRequest(action.id)} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}
