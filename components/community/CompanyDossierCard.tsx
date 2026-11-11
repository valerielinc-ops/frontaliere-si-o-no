import React from 'react';
import { Building2, Globe, Users, Briefcase, ExternalLink, Award } from 'lucide-react';

export interface CompanyIntelligenceData {
  companyName: string;
  ceo?: string | null;
  employees?: number | null;
  website?: string | null;
  linkedinUrl?: string | null;
  wikipediaSummary?: string | null;
}

export interface CompanyDossierCardProps {
  data: CompanyIntelligenceData;
  className?: string;
}

export const CompanyDossierCard: React.FC<CompanyDossierCardProps> = ({
  data,
  className = '',
}) => {
  const { companyName, ceo, employees, website, linkedinUrl, wikipediaSummary } = data;

  const formatEmployeeCount = (num?: number | null) => {
    if (!num) return null;
    if (num >= 10000) return `${(num / 1000).toFixed(0)}k+ dipendenti (Grande impresa)`;
    if (num >= 250) return `${num.toLocaleString('it-CH')} dipendenti (Media impresa)`;
    return `${num.toLocaleString('it-CH')} dipendenti (Piccola impresa)`;
  };

  const hasData = Boolean(ceo || employees || website || linkedinUrl || wikipediaSummary);
  if (!hasData) return null;

  return (
    <section
      data-testid="company-dossier-card"
      className={`rounded-2xl border border-edge bg-surface/90 p-4 sm:p-5 space-y-3 ${className}`}
      aria-label={`Dossier aziendale: ${companyName}`}
    >
      <div className="flex items-center justify-between border-b border-edge/60 pb-2.5">
        <h3 className="text-sm font-bold font-display uppercase tracking-wider text-heading flex items-center gap-2">
          <Building2 className="w-4 h-4 text-accent" />
          Scheda Azienda & Intelligence
        </h3>
        <span className="text-[11px] font-medium text-muted flex items-center gap-1">
          <Award className="w-3 h-3 text-info" />
          Dati verificati
        </span>
      </div>

      {wikipediaSummary && (
        <p className="text-xs sm:text-sm text-subtle leading-relaxed italic">
          "{wikipediaSummary}"
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1 text-xs">
        {ceo && (
          <div className="flex items-center gap-2 p-2 rounded-xl bg-surface-raised border border-edge/50">
            <Briefcase className="w-4 h-4 text-accent shrink-0" />
            <div className="min-w-0">
              <span className="text-muted text-[10px] uppercase font-semibold block">CEO / Direzione</span>
              <span className="font-semibold text-heading truncate block">{ceo}</span>
            </div>
          </div>
        )}

        {employees && (
          <div className="flex items-center gap-2 p-2 rounded-xl bg-surface-raised border border-edge/50">
            <Users className="w-4 h-4 text-success shrink-0" />
            <div className="min-w-0">
              <span className="text-muted text-[10px] uppercase font-semibold block">Organico</span>
              <span className="font-semibold text-heading truncate block">{formatEmployeeCount(employees)}</span>
            </div>
          </div>
        )}

        {website && (
          <div className="flex items-center gap-2 p-2 rounded-xl bg-surface-raised border border-edge/50">
            <Globe className="w-4 h-4 text-info shrink-0" />
            <div className="min-w-0">
              <span className="text-muted text-[10px] uppercase font-semibold block">Sito Ufficiale</span>
              <a
                href={website}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-accent hover:underline flex items-center gap-1 truncate"
              >
                {new URL(website).hostname.replace(/^www\./, '')}
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </div>
        )}

        {linkedinUrl && (
          <div className="flex items-center gap-2 p-2 rounded-xl bg-surface-raised border border-edge/50">
            <Users className="w-4 h-4 text-[#0077b5] shrink-0" />
            <div className="min-w-0">
              <span className="text-muted text-[10px] uppercase font-semibold block">LinkedIn</span>
              <a
                href={linkedinUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-[#0077b5] hover:underline flex items-center gap-1 truncate"
              >
                Pagina Aziendale
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};
