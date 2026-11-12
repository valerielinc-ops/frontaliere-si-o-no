/**
 * Compare skills a candidate explicitly entered with skills and languages
 * named in a job's requirements. This is a partial keyword comparison, not a
 * CV parser or a prediction of hiring chances.
 */

export type CvMatchLocale = 'it' | 'en' | 'de' | 'fr';
export type CvMatchStatus = 'ready' | 'missing-profile' | 'no-job-skills' | 'unrecognized-profile';

interface SkillDefinition {
  id: string;
  labels: Record<CvMatchLocale, string>;
  aliases: string[];
}

export interface CvMatchInput {
  candidateSkills: string[];
  jobRequirements: string[];
  preferredSkills?: string[];
  locale?: CvMatchLocale;
}

export interface CvMatchResult {
  status: CvMatchStatus;
  /** Null means there is not enough explicit data for a meaningful percentage. */
  overall: number | null;
  jobSkills: string[];
  matchedSkills: string[];
  missingSkills: string[];
  candidateOnlySkills: string[];
}

const SKILLS: SkillDefinition[] = [
  {
    id: 'regulatory-affairs',
    labels: { it: 'Affari regolatori', en: 'Regulatory affairs', de: 'Regulatory Affairs', fr: 'Affaires réglementaires' },
    aliases: ['affari regolatori', 'affari regolamentari', 'regulatory affairs'],
  },
  {
    id: 'pharmaceutical-industry',
    labels: { it: 'Industria farmaceutica', en: 'Pharmaceutical industry', de: 'Pharmaindustrie', fr: 'Industrie pharmaceutique' },
    aliases: ['industria farmaceutica', 'settore farmaceutico', 'pharmaceutical industry', 'pharma industry'],
  },
  {
    id: 'finished-medicinal-products',
    labels: { it: 'Medicinali finiti', en: 'Finished medicinal products', de: 'Fertigarzneimittel', fr: 'Médicaments finis' },
    aliases: ['medicinali finiti', 'medicinal products', 'finished medicinal products', 'finished products'],
  },
  {
    id: 'small-molecules',
    labels: { it: 'Piccole molecole', en: 'Small molecules', de: 'Kleine Moleküle', fr: 'Petites molécules' },
    aliases: ['piccole molecole', 'small molecules', 'small molecule'],
  },
  {
    id: 'pharmaceutical-regulation',
    labels: { it: 'Normativa farmaceutica', en: 'Pharmaceutical regulation', de: 'Arzneimittelrecht', fr: 'Réglementation pharmaceutique' },
    aliases: ['legislazione farmaceutica', 'normativa farmaceutica', 'pharmaceutical legislation', 'pharmaceutical law', 'pharmaceutical regulation'],
  },
  {
    id: 'eu-registration-procedures',
    labels: { it: 'Registrazioni UE', en: 'EU registration procedures', de: 'EU-Zulassungsverfahren', fr: 'Procédures d’enregistrement UE' },
    aliases: ['registrazioni ue', 'registrazione ue', 'registrazioni europee', 'eu registrations', 'eu registration', 'registration procedures', 'procedure di registrazione', 'mrp', 'dcp', 'maa', 'maas'],
  },
  {
    id: 'regulatory-variations',
    labels: { it: 'Variazioni regolatorie', en: 'Regulatory variations', de: 'Zulassungsänderungen', fr: 'Variations réglementaires' },
    aliases: ['variazioni regolatorie', 'variazioni', 'regulatory variations', 'variations'],
  },
  {
    id: 'marketing-authorization',
    labels: { it: 'Autorizzazioni all’immissione in commercio', en: 'Marketing authorizations', de: 'Zulassungen für das Inverkehrbringen', fr: 'Autorisations de mise sur le marché' },
    aliases: ['autorizzazione all immissione in commercio', 'autorizzazioni all immissione in commercio', 'marketing authorization', 'marketing authorisation', 'marketing authorization application', 'marketing authorisation application'],
  },
  {
    id: 'renewal-submissions',
    labels: { it: 'Rinnovi delle autorizzazioni', en: 'Authorization renewals', de: 'Verlängerungen von Zulassungen', fr: 'Renouvellements d’autorisations' },
    aliases: ['rinnovi', 'rinnovo', 'renewals', 'renewal applications', 'authorization renewals', 'authorisation renewals'],
  },
  {
    id: 'non-eu-registrations',
    labels: { it: 'Registrazioni extra UE', en: 'Non-EU registrations', de: 'Zulassungen außerhalb der EU', fr: 'Enregistrements hors UE' },
    aliases: ['registrazioni non ue', 'registrazioni extra ue', 'non eu registrations', 'non-eu registrations', 'registrations outside the eu'],
  },
  {
    id: 'regulatory-compliance',
    labels: { it: 'Conformità normativa', en: 'Regulatory compliance', de: 'Regulatorische Compliance', fr: 'Conformité réglementaire' },
    aliases: ['conformita normativa', 'conformita regolatoria', 'regulatory compliance'],
  },
  {
    id: 'product-labeling',
    labels: { it: 'Etichettatura dei prodotti', en: 'Product labeling', de: 'Produktkennzeichnung', fr: 'Étiquetage des produits' },
    aliases: ['etichettatura dei prodotti', 'etichettatura', 'product labeling', 'product labelling', 'labeling', 'labelling'],
  },
  {
    id: 'organization-planning',
    labels: { it: 'Organizzazione e pianificazione', en: 'Organization and planning', de: 'Organisation und Planung', fr: 'Organisation et planification' },
    aliases: ['capacita organizzative e di pianificazione', 'organizzative e di pianificazione', 'organization and planning', 'organizational and planning skills', 'organisation und planung', 'organisation et planification'],
  },
  {
    id: 'regulatory-communication',
    labels: { it: 'Comunicazione dei requisiti normativi', en: 'Regulatory communication', de: 'Kommunikation regulatorischer Anforderungen', fr: 'Communication des exigences réglementaires' },
    aliases: ['comunicare efficacemente i requisiti normativi', 'interpretare e comunicare i requisiti normativi', 'regulatory requirements communication', 'communicate regulatory requirements'],
  },
  {
    id: 'written-oral-communication',
    labels: { it: 'Comunicazione scritta e verbale', en: 'Written and verbal communication', de: 'Schriftliche und mündliche Kommunikation', fr: 'Communication écrite et orale' },
    aliases: ['comunicazione scritta e verbale', 'written and verbal communication', 'written and spoken communication', 'schriftliche und mundliche kommunikation', 'communication ecrite et orale'],
  },
  {
    id: 'teamwork',
    labels: { it: 'Collaborazione in team', en: 'Teamwork', de: 'Teamarbeit', fr: 'Travail en équipe' },
    aliases: ['collaborazione interpersonale e di team', 'lavoro di squadra', 'teamwork', 'team collaboration', 'teamarbeit', 'travail en equipe'],
  },
  {
    id: 'deadline-management',
    labels: { it: 'Gestione delle scadenze', en: 'Deadline management', de: 'Terminmanagement', fr: 'Gestion des délais' },
    aliases: ['gestire efficacemente le scadenze', 'gestione delle scadenze', 'deadline management', 'manage deadlines', 'terminmanagement', 'gestion des delais'],
  },
  {
    id: 'independent-work',
    labels: { it: 'Lavoro indipendente', en: 'Independent work', de: 'Selbstständiges Arbeiten', fr: 'Travail autonome' },
    aliases: ['lavorare in modo indipendente', 'lavoro indipendente', 'work independently', 'independent work', 'selbststandig arbeiten', 'travail autonome'],
  },
  {
    id: 'attention-to-detail',
    labels: { it: 'Attenzione ai dettagli', en: 'Attention to detail', de: 'Aufmerksamkeit für Details', fr: 'Sens du détail' },
    aliases: ['attenzione ai dettagli', 'orientata ai dettagli', 'detail oriented', 'attention to detail', 'aufmerksamkeit fur details', 'sens du detail'],
  },
  {
    id: 'quality-orientation',
    labels: { it: 'Orientamento alla qualità', en: 'Quality orientation', de: 'Qualitätsorientierung', fr: 'Orientation qualité' },
    aliases: ['impegno alla qualita', 'attenzione alla qualita', 'quality orientation', 'commitment to quality', 'qualitatsorientierung', 'orientation qualite'],
  },
  { id: 'english', labels: { it: 'Inglese', en: 'English', de: 'Englisch', fr: 'Anglais' }, aliases: ['inglese', 'english', 'englisch', 'anglais'] },
  { id: 'french', labels: { it: 'Francese', en: 'French', de: 'Französisch', fr: 'Français' }, aliases: ['francese', 'french', 'franzosisch', 'francais'] },
  { id: 'german', labels: { it: 'Tedesco', en: 'German', de: 'Deutsch', fr: 'Allemand' }, aliases: ['tedesco', 'german', 'deutsch', 'allemand'] },
  { id: 'italian', labels: { it: 'Italiano', en: 'Italian', de: 'Italienisch', fr: 'Italien' }, aliases: ['italiano', 'italian', 'italienisch', 'italien'] },
  { id: 'typescript', labels: { it: 'TypeScript', en: 'TypeScript', de: 'TypeScript', fr: 'TypeScript' }, aliases: ['typescript'] },
  { id: 'react', labels: { it: 'React', en: 'React', de: 'React', fr: 'React' }, aliases: ['react'] },
  { id: 'git', labels: { it: 'Git', en: 'Git', de: 'Git', fr: 'Git' }, aliases: ['git'] },
  { id: 'nodejs', labels: { it: 'Node.js', en: 'Node.js', de: 'Node.js', fr: 'Node.js' }, aliases: ['node js', 'nodejs'] },
  { id: 'javascript', labels: { it: 'JavaScript', en: 'JavaScript', de: 'JavaScript', fr: 'JavaScript' }, aliases: ['javascript'] },
  { id: 'python', labels: { it: 'Python', en: 'Python', de: 'Python', fr: 'Python' }, aliases: ['python'] },
  { id: 'java', labels: { it: 'Java', en: 'Java', de: 'Java', fr: 'Java' }, aliases: ['java'] },
  { id: 'sql', labels: { it: 'SQL', en: 'SQL', de: 'SQL', fr: 'SQL' }, aliases: ['sql'] },
  { id: 'postgresql', labels: { it: 'PostgreSQL', en: 'PostgreSQL', de: 'PostgreSQL', fr: 'PostgreSQL' }, aliases: ['postgresql', 'postgres'] },
  { id: 'mysql', labels: { it: 'MySQL', en: 'MySQL', de: 'MySQL', fr: 'MySQL' }, aliases: ['mysql'] },
  { id: 'docker', labels: { it: 'Docker', en: 'Docker', de: 'Docker', fr: 'Docker' }, aliases: ['docker'] },
  { id: 'kubernetes', labels: { it: 'Kubernetes', en: 'Kubernetes', de: 'Kubernetes', fr: 'Kubernetes' }, aliases: ['kubernetes', 'k8s'] },
  { id: 'aws', labels: { it: 'AWS', en: 'AWS', de: 'AWS', fr: 'AWS' }, aliases: ['aws', 'amazon web services'] },
  { id: 'azure', labels: { it: 'Microsoft Azure', en: 'Microsoft Azure', de: 'Microsoft Azure', fr: 'Microsoft Azure' }, aliases: ['azure', 'microsoft azure'] },
  { id: 'google-cloud', labels: { it: 'Google Cloud', en: 'Google Cloud', de: 'Google Cloud', fr: 'Google Cloud' }, aliases: ['google cloud', 'gcp'] },
  { id: 'excel', labels: { it: 'Excel', en: 'Excel', de: 'Excel', fr: 'Excel' }, aliases: ['excel', 'microsoft excel'] },
  { id: 'sap', labels: { it: 'SAP', en: 'SAP', de: 'SAP', fr: 'SAP' }, aliases: ['sap'] },
  { id: 'power-bi', labels: { it: 'Power BI', en: 'Power BI', de: 'Power BI', fr: 'Power BI' }, aliases: ['power bi'] },
  { id: 'tableau', labels: { it: 'Tableau', en: 'Tableau', de: 'Tableau', fr: 'Tableau' }, aliases: ['tableau'] },
  { id: 'salesforce', labels: { it: 'Salesforce', en: 'Salesforce', de: 'Salesforce', fr: 'Salesforce' }, aliases: ['salesforce'] },
  { id: 'agile', labels: { it: 'Agile', en: 'Agile', de: 'Agile', fr: 'Agile' }, aliases: ['agile', 'scrum'] },
  {
    id: 'project-management',
    labels: { it: 'Project management', en: 'Project management', de: 'Projektmanagement', fr: 'Gestion de projet' },
    aliases: ['project management', 'gestione progetti', 'projektmanagement', 'gestion de projet'],
  },
];

function normalizeSkillText(value: string): string {
  return String(value || '')
    .toLocaleLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function containsPhrase(normalizedText: string, normalizedPhrase: string): boolean {
  return ` ${normalizedText} `.includes(` ${normalizedPhrase} `);
}

function matchingDefinitions(text: string): SkillDefinition[] {
  const normalizedText = normalizeSkillText(text);
  if (!normalizedText) return [];
  return SKILLS.filter((skill) => skill.aliases.some((alias) => {
    const normalizedAlias = normalizeSkillText(alias);
    return normalizedAlias.length > 0 && containsPhrase(normalizedText, normalizedAlias);
  }));
}

function uniqueLabels(skills: SkillDefinition[], locale: CvMatchLocale): string[] {
  return skills.map((skill) => skill.labels[locale] || skill.labels.it);
}

/** Return a conservative skill overlap score; unavailable evidence stays null. */
export function computeCvMatch(input: CvMatchInput): CvMatchResult {
  const locale = input.locale || 'it';
  const candidateText = (Array.isArray(input.candidateSkills) ? input.candidateSkills : [])
    .filter((skill): skill is string => typeof skill === 'string')
    .join(' ');
  const jobText = [
    ...(Array.isArray(input.jobRequirements) ? input.jobRequirements : []),
    ...(Array.isArray(input.preferredSkills) ? input.preferredSkills : []),
  ].filter((skill): skill is string => typeof skill === 'string').join(' ');

  const candidateDefinitions = matchingDefinitions(candidateText);
  const jobDefinitions = matchingDefinitions(jobText);
  const candidateIds = new Set(candidateDefinitions.map((skill) => skill.id));
  const jobIds = new Set(jobDefinitions.map((skill) => skill.id));
  const matchedDefinitions = jobDefinitions.filter((skill) => candidateIds.has(skill.id));
  const missingDefinitions = jobDefinitions.filter((skill) => !candidateIds.has(skill.id));
  const candidateOnlyDefinitions = candidateDefinitions.filter((skill) => !jobIds.has(skill.id));

  let status: CvMatchStatus;
  if (!candidateText.trim()) status = 'missing-profile';
  else if (jobDefinitions.length === 0) status = 'no-job-skills';
  else if (candidateDefinitions.length === 0) status = 'unrecognized-profile';
  else status = 'ready';

  const overall = status === 'ready' && jobDefinitions.length > 0
    ? Math.round((matchedDefinitions.length / jobDefinitions.length) * 100)
    : null;

  return {
    status,
    overall,
    jobSkills: uniqueLabels(jobDefinitions, locale),
    matchedSkills: uniqueLabels(matchedDefinitions, locale),
    missingSkills: uniqueLabels(missingDefinitions, locale),
    candidateOnlySkills: uniqueLabels(candidateOnlyDefinitions, locale),
  };
}
