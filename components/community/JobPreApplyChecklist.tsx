import React from 'react';
import { ClipboardCheck, CheckCircle2, ShieldCheck, HelpCircle, FileText } from 'lucide-react';

export interface PreApplyFieldItem {
  id: string;
  label: string;
  expectedValue: string;
  source: 'smart_default' | 'ats_field' | 'verified_benchmark';
  helpText: string;
}

export interface JobPreApplyChecklistProps {
  companyName: string;
  canton?: string;
  salaryBenchmarkChf?: string | null;
  className?: string;
}

export const JobPreApplyChecklist: React.FC<JobPreApplyChecklistProps> = ({
  companyName,
  canton = 'TI',
  salaryBenchmarkChf = null,
  className = '',
}) => {
  const fields: PreApplyFieldItem[] = [
    {
      id: 'work_permit',
      label: 'Permesso di soggiorno / Arbeitsbewilligung',
      expectedValue: 'Permesso G Frontalieri (Cittadini UE/AELS)',
      source: 'smart_default',
      helpText: 'Il datore di lavoro svizzero richiederà la disponibilità del Permesso G per residenti nella fascia di confine.',
    },
    {
      id: 'notice_period',
      label: 'Termine di disdetta / Kündigungsfrist',
      expectedValue: '3 mesi (Standard mercato svizzero)',
      source: 'smart_default',
      helpText: 'Preavviso standard conformemente all\'art. 335c CO svizzero.',
    },
    {
      id: 'pensum',
      label: 'Grado di occupazione / Pensum',
      expectedValue: '100% (Tempo pieno) o da concordare',
      source: 'smart_default',
      helpText: 'Grado di impegno standard indicato per le posizioni aperte nel cantone.',
    },
    {
      id: 'salary_expectation',
      label: 'Aspettativa salariale / Lohnvorstellung',
      expectedValue: salaryBenchmarkChf || 'Allineata ai salari mediani svizzeri (CHF lordi annui)',
      source: 'verified_benchmark',
      helpText: 'Indicare sempre la cifra lorda in franchi svizzeri (CHF), non in Euro.',
    },
  ];

  return (
    <section
      data-testid="job-preapply-checklist"
      className={`rounded-2xl border border-edge bg-surface/90 p-4 sm:p-5 space-y-3.5 ${className}`}
      aria-label={`Modulo ATS e requisiti di candidatura per ${companyName}`}
    >
      <div className="flex items-center justify-between border-b border-edge/60 pb-2.5">
        <h3 className="text-sm font-bold font-display uppercase tracking-wider text-heading flex items-center gap-2">
          <ClipboardCheck className="w-4 h-4 text-accent" />
          Domande previste nel modulo ATS ({companyName})
        </h3>
        <span className="text-[11px] font-semibold text-success flex items-center gap-1">
          <ShieldCheck className="w-3.5 h-3.5" />
          Pre-compilabile
        </span>
      </div>

      <p className="text-xs text-subtle leading-relaxed">
        Prima di cliccare su <em>Candidati</em>, ecco i campi e le domande tipiche che il portale o l'ATS dell'azienda ti richiederà di compilare:
      </p>

      <div className="space-y-2 pt-1">
        {fields.map((field) => (
          <div
            key={field.id}
            className="p-2.5 rounded-xl bg-surface-raised border border-edge/50 flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 text-xs"
          >
            <div className="min-w-0 flex-1">
              <span className="font-semibold text-heading block">{field.label}</span>
              <span className="text-[11px] text-muted block mt-0.5">{field.helpText}</span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0 bg-surface px-2.5 py-1 rounded-lg border border-edge font-medium text-accent">
              <CheckCircle2 className="w-3.5 h-3.5 text-success" />
              <span>{field.expectedValue}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 pt-1 text-[11px] text-muted">
        <FileText className="w-3.5 h-3.5 text-accent shrink-0" />
        <span>
          Suggerimento: allega sempre un CV strutturato in standard ATS (singola colonna, senza tabelle complesse).
        </span>
      </div>
    </section>
  );
};
