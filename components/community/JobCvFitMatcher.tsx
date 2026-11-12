import React, { useState, useMemo } from 'react';
import { Target, CheckCircle2, AlertCircle, FileDown, Edit3 } from 'lucide-react';
import { computeCvMatch, type CvMatchResult } from '../../services/cvmatch';

export interface JobCvFitMatcherProps {
  jobTitle: string;
  requirements?: string[];
  preferredSkills?: string[];
  seniority?: 'junior' | 'mid' | 'senior' | 'lead';
  onDownloadBilingualCv?: () => void;
  className?: string;
}

export const JobCvFitMatcher: React.FC<JobCvFitMatcherProps> = ({
  jobTitle,
  requirements = [],
  preferredSkills = [],
  seniority = 'mid',
  onDownloadBilingualCv,
  className = '',
}) => {
  const [candidateSkillsText, setCandidateSkillsText] = useState(
    'TypeScript, React, Node.js, SQL, Docker, Git, Agile'
  );
  const [candidateSeniority, setCandidateSeniority] = useState<'junior' | 'mid' | 'senior' | 'lead'>(seniority);
  const [isEditing, setIsEditing] = useState(false);

  // Normalizza le skill del job
  const jobSkills = useMemo(() => {
    const combined = [...requirements, ...preferredSkills];
    return combined.length > 0 ? combined : ['TypeScript', 'React', 'Git'];
  }, [requirements, preferredSkills]);

  // Calcola match deterministico FreeHire 40/30/20/10
  const matchResult: CvMatchResult = useMemo(() => {
    const parsedSkills = candidateSkillsText
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);

    const cvText = `${jobTitle} specialist with skills in ${parsedSkills.join(', ')}. Seniority: ${candidateSeniority}.`;

    return computeCvMatch({
      cvText,
      cvSkills: parsedSkills,
      jobTitle,
      jobSkills,
      jobSeniority: candidateSeniority,
      requirements: requirements.map((req) => ({
        text: req,
        requiredSkills: [req],
      })),
    });
  }, [candidateSkillsText, candidateSeniority, jobTitle, jobSkills, requirements]);

  const score = matchResult.overall;
  const scoreColor =
    score >= 75 ? 'text-success' : score >= 50 ? 'text-warning' : 'text-danger';
  const scoreBg =
    score >= 75 ? 'bg-success-subtle border-success-border' : score >= 50 ? 'bg-warning-subtle border-warning-border' : 'bg-danger-subtle border-danger-border';

  return (
    <section
      data-testid="job-cv-fit-matcher"
      className={`rounded-2xl border border-edge bg-surface/90 p-4 sm:p-5 space-y-4 ${className}`}
      aria-label="Verifica compatibilità CV con l'annuncio"
    >
      <div className="flex items-center justify-between border-b border-edge/60 pb-3">
        <div className="flex items-center gap-2">
          <Target className="w-5 h-5 text-accent" />
          <h3 className="text-sm font-bold font-display uppercase tracking-wider text-heading">
            Verifica Affinità CV (FreeHire Matcher)
          </h3>
        </div>
        <button
          type="button"
          onClick={() => setIsEditing((prev) => !prev)}
          className="text-xs font-semibold text-accent hover:underline flex items-center gap-1"
        >
          <Edit3 className="w-3.5 h-3.5" />
          {isEditing ? 'Chiudi modifica' : 'Modifica competenze'}
        </button>
      </div>

      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-3.5 rounded-xl border bg-surface-raised">
        <div className="flex items-center gap-3.5">
          <div className={`w-14 h-14 rounded-2xl border flex flex-col items-center justify-center shrink-0 ${scoreBg}`}>
            <span className={`text-xl font-extrabold font-display leading-none ${scoreColor}`}>
              {score}%
            </span>
            <span className="text-[9px] font-bold uppercase tracking-wider text-muted mt-0.5">Fit</span>
          </div>
          <div>
            <span className="font-bold font-display text-heading block text-sm">
              {score >= 75 ? 'Profilo fortemente allineato' : score >= 50 ? 'Allineamento discreto' : 'Competenze da integrare'}
            </span>
            <span className="text-xs text-muted block mt-0.5">
              Calcolato sui requisiti ATS per: <em>{jobTitle}</em>
            </span>
          </div>
        </div>

        {onDownloadBilingualCv && (
          <button
            type="button"
            onClick={onDownloadBilingualCv}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-accent text-on-accent hover:bg-accent-hover transition-colors shrink-0"
          >
            <FileDown className="w-3.5 h-3.5" />
            Scarica CV Bilingue (IT/DE)
          </button>
        )}
      </div>

      {isEditing && (
        <div className="p-3 rounded-xl border border-accent-border/50 bg-accent-subtle/30 space-y-2">
          <label className="text-xs font-semibold text-heading block">
            Le tue competenze chiave (separate da virgola):
          </label>
          <textarea
            value={candidateSkillsText}
            onChange={(e) => setCandidateSkillsText(e.target.value)}
            className="w-full text-xs p-2 rounded-lg border border-edge bg-surface text-body focus:outline-none focus:ring-1 focus:ring-accent"
            rows={2}
          />
        </div>
      )}

      {/* Breakdown competenze */}
      <div className="space-y-2.5 text-xs">
        <div>
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted block mb-1.5">
            Competenze Rilevate nel Tuo Profilo ({matchResult.matchedSkills.length})
          </span>
          <div className="flex flex-wrap gap-1.5">
            {matchResult.matchedSkills.map((skill) => (
              <span
                key={skill}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-success-subtle text-success border border-success-border font-medium"
              >
                <CheckCircle2 className="w-3 h-3" />
                {skill}
              </span>
            ))}
            {matchResult.matchedSkills.length === 0 && (
              <span className="text-muted text-xs italic">Nessuna competenza comune rilevata.</span>
            )}
          </div>
        </div>

        {matchResult.missingSkills.length > 0 && (
          <div className="pt-1">
            <span className="text-[11px] font-bold uppercase tracking-wider text-muted block mb-1.5">
              Competenze Richieste Mancanti ({matchResult.missingSkills.length})
            </span>
            <div className="flex flex-wrap gap-1.5">
              {matchResult.missingSkills.map((skill) => (
                <span
                  key={skill}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-warning-subtle text-warning border border-warning-border font-medium"
                >
                  <AlertCircle className="w-3 h-3" />
                  {skill}
                </span>
              ))}
            </div>
            <p className="text-[11px] text-muted mt-2">
              💡 Consiglio FreeHire: evidenzia nella lettera di motivazione la disponibilità ad apprendere rapidamente le tecnologie mancanti.
            </p>
          </div>
        )}
      </div>
    </section>
  );
};
