import { useAdminWorkflow, WORKFLOW_CONTEXT_META } from '@/components/admin/AdminWorkflowProvider';
import type { WorkflowContext } from '@/components/admin/lib/adminTypes';
import { WorkflowCard } from './workflow/WorkflowCard';

const contexts: WorkflowContext[] = ['content', 'seo', 'analytics'];

export default function AutomazioniSection() {
  const workflow = useAdminWorkflow();
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-edge bg-surface-alt/40 p-3">
        <div className="text-xs font-semibold text-body">Azioni automatiche: avvio workflow e monitoraggio completo</div>
        <p className="text-sm text-muted">Ogni bottone avvia un workflow GitHub, ne mostra lo stato in tempo reale e riassume output/errori direttamente qui.</p>
      </div>
      {contexts.map((context) => {
        const meta = WORKFLOW_CONTEXT_META[context];
        const actions = workflow.actions.filter((action) => action.context === context && !action.isUtility);
        return (
          <section key={context} className="space-y-3">
            <div className="rounded-lg border border-edge bg-surface-alt/40 px-3 py-2"><h2 className="text-sm font-bold text-body">{meta.label}</h2><p className="text-[11px] text-muted mt-0.5">{meta.description}</p></div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {actions.map((action) => <WorkflowCard key={action.id} workflow={action} state={workflow.getWorkflowState(action.id)} onRun={() => { void workflow.runWorkflowWithConfirmation(action.id); }} onCopy={() => { void workflow.copyAiFixRequest(action.id); }} onOpen={() => workflow.openAiFixRequest(action.id)} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}
