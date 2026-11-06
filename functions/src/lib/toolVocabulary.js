/**
 * Closed vocabulary of tools, technologies and certificates for the fact gate.
 *
 * The shape rule of `toolTokens` (an acronym, a capital with a digit, an inner
 * capital) cannot see a tool written as a plain capitalised word: "Kubernetes",
 * "Salesforce", "Excel". A German CV capitalises every noun, so widening the
 * shape rule would flag half of every letter; a closed list names exactly the
 * words that are claims. Study 2026-10-02 (report-cv-lettera §5, §8): the
 * tailored CV kept "Deploy su Kubernetes" and a summary with "Kubernetes e AWS"
 * that no CV named.
 *
 * Entries also carry the surface forms a recruiter treats as the same thing
 * ("k8s" and "Kubernetes", "Postgres" and "PostgreSQL"), so a CV that says one
 * backs a letter that says the other.
 *
 * Sources (MIT, see THIRD_PARTY_NOTICES.md): the skill vocabulary of
 * career-ops `skill-extract.mjs` (© 2026 Santiago Fernández de Valderrama) and
 * the alias table of Reactive Resume `ats-pdf/jd/aliases.ts` (© 2026 Amruth
 * Pillai), filtered to named tools and certificates, plus the Swiss software,
 * health and language certificates a Swiss posting asks for.
 *
 * `cs: true` marks a name that is also an ordinary word ("Go", "Spring",
 * "Access"): it counts only with its exact capitalisation. `implies`: a suite
 * that backs its members ("Microsoft Office" backs Excel).
 */

const T = (name, aliases = [], extra = {}) => ({ name, aliases, ...extra });

export const TOOL_VOCABULARY = Object.freeze([
  // Languages and runtimes
  T('JavaScript', ['JS', 'ECMAScript']), T('TypeScript', ['TS']), T('Python', ['Python3']), T('Ruby'),
  T('Java', [], { cs: true }), T('Go', ['Golang'], { cs: true }), T('Rust', [], { cs: true }), T('PHP'), T('Kotlin'),
  T('Swift', [], { cs: true }), T('Scala'), T('Elixir'), T('C++', ['CPP']), T('C#', ['CSharp']), T('.NET', ['dotnet', 'ASP.NET']),
  T('SQL'), T('MATLAB'), T('VBA'), T('Bash'), T('PowerShell'), T('COBOL'), T('Dart'), T('Flutter'),
  // Front end
  T('React', ['ReactJS', 'React.js']), T('React Native'), T('Angular', ['AngularJS']), T('Vue', ['Vue.js', 'VueJS']),
  T('Svelte', ['SvelteKit']), T('Next.js', ['NextJS']), T('Nuxt', ['NuxtJS']), T('HTML', ['HTML5']), T('CSS', ['CSS3']),
  T('Sass', ['SCSS']), T('Tailwind', ['TailwindCSS']), T('jQuery'), T('Bootstrap', [], { cs: true }), T('WordPress'),
  // Back end and data
  T('Node.js', ['Node', 'NodeJS'], { cs: true }), T('Django'), T('Flask', [], { cs: true }), T('FastAPI'), T('Rails', ['Ruby on Rails'], { cs: true }),
  T('Laravel'), T('Symfony'), T('Spring', ['Spring Boot'], { cs: true }),
  T('PostgreSQL', ['Postgres', 'psql']), T('MySQL'), T('SQL Server', ['MSSQL', 'MS SQL']), T('Oracle', [], { cs: true }),
  T('MongoDB', ['Mongo']), T('Redis'), T('Elasticsearch'), T('Snowflake', [], { cs: true }), T('BigQuery'), T('Databricks'),
  T('DynamoDB'), T('GraphQL'), T('gRPC'), T('Kafka'), T('RabbitMQ'), T('Firebase'),
  // Cloud, ops, tooling
  T('AWS', ['Amazon Web Services']), T('GCP', ['Google Cloud']), T('Azure', [], { cs: true }), T('Docker'), T('Kubernetes', ['k8s']),
  T('Terraform'), T('Ansible'), T('Jenkins'), T('GitHub Actions'), T('GitLab CI'), T('CI/CD'),
  T('Git'), T('GitHub'), T('GitLab'), T('Bitbucket'), T('Jira'), T('Confluence'), T('Prometheus'), T('Grafana'), T('Datadog'),
  T('Splunk'), T('OpenTelemetry', ['OTel']), T('Linux'), T('Windows Server'), T('Active Directory'), T('VMware'), T('Hyper-V'),
  T('Cisco'), T('CCNA'), T('Supabase'),
  // Data, ML
  T('PyTorch'), T('TensorFlow'), T('scikit-learn'), T('Pandas', [], { cs: true }), T('NumPy'), T('Spark', ['Apache Spark'], { cs: true }),
  T('Airflow'), T('dbt', [], { cs: true }), T('MLflow'), T('LangChain'), T('LlamaIndex'), T('Hugging Face'), T('Power BI', ['PowerBI']),
  T('Tableau'), T('Looker'), T('Qlik', ['QlikView', 'Qlik Sense']), T('SPSS'), T('Stata'),
  // Testing
  T('JUnit'), T('pytest'), T('Jest'), T('Selenium'), T('Playwright'), T('Cypress', [], { cs: true }), T('Postman'),
  // Business software (Swiss ERP and accounting included)
  T('SAP', ['SAP S/4HANA', 'S/4HANA', 'SAP R/3', 'SAP FI', 'SAP CO', 'SAP MM', 'SAP SD', 'SAP HCM']), T('Abacus', [], { cs: true }),
  T('Bexio'), T('Sage', [], { cs: true }), T('Navision', ['Dynamics NAV']), T('Microsoft Dynamics', ['Dynamics 365']),
  T('Salesforce'), T('HubSpot'), T('Workday', [], { cs: true }), T('SuccessFactors'), T('Marketo'), T('Zapier'),
  T('Google Analytics', ['GA4']), T('Google Ads'), T('Google Tag Manager'),
  // Office
  T('Microsoft Office', ['MS Office', 'Office 365', 'Microsoft 365', 'M365'], { implies: ['Excel', 'PowerPoint', 'Outlook', 'Access', 'SharePoint'] }),
  T('Excel', ['MS Excel']), T('PowerPoint'), T('Outlook', [], { cs: true }), T('Access', ['MS Access'], { cs: true }), T('SharePoint'),
  // Design, CAD
  T('AutoCAD'), T('Revit'), T('ArchiCAD'), T('SolidWorks'), T('CATIA'),
  T('Photoshop'), T('Illustrator', [], { cs: true }), T('InDesign'), T('Figma'), T('Canva'), T('Premiere Pro'), T('After Effects'),
  // Health (Swiss hospital systems, life support)
  T('KISIM'), T('Polypoint'), T('Cerner'), T('Meona'), T('Orbis', [], { cs: true }), T('BLS', ['BLS-AED']), T('ACLS'), T('PALS'),
  // Project and quality management certificates
  T('PMP'), T('PRINCE2', ['PRINCE 2']), T('ITIL'), T('COBIT'), T('TOGAF'),
  T('Six Sigma', ['Lean Six Sigma']), T('CISSP'), T('CISM'), T('IPMA'),
  // Language certificates
  T('Goethe-Zertifikat', ['Goethe Zertifikat']), T('DELF'), T('DALF'), T('TOEFL'), T('IELTS'), T('CILS'), T('CELI'), T('TestDaF'),
]);

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BOUNDARY_BEFORE = '(?<![\\p{L}\\p{N}+#.])';
const BOUNDARY_AFTER = '(?![\\p{L}\\p{N}+#])';
// "S/4HANA", "S/4 HANA" and "S4HANA" are one name; so are "Node.js" and "NodeJS".
const flexible = (form) => (form.startsWith('.') ? '\\.' : '') + form.split(/[^\p{L}\p{N}+#]+|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u).filter(Boolean).map(escape).join('[\\s/._-]{0,2}');

for (const entry of TOOL_VOCABULARY) {
  entry.patterns = [entry.name, ...entry.aliases].map((form) => new RegExp(`${BOUNDARY_BEFORE}${flexible(form)}${BOUNDARY_AFTER}`, entry.cs ? 'u' : 'iu'));
  entry.exact = [entry.name, ...entry.aliases].map((form) => new RegExp(`^${flexible(form)}$`, entry.cs ? 'u' : 'iu'));
}

// Every surface form, longest first so "React Native" wins over "React".
const FORMS = TOOL_VOCABULARY.flatMap((entry) => [entry.name, ...entry.aliases].map((form) => ({ form, entry })))
  .sort((left, right) => right.form.length - left.form.length);
const scanner = (sensitive) => new RegExp(
  `${BOUNDARY_BEFORE}(?:${FORMS.filter(({ entry }) => Boolean(entry.cs) === sensitive).map(({ form }) => flexible(form)).join('|')})${BOUNDARY_AFTER}`,
  sensitive ? 'gu' : 'giu',
);
const SCANNERS = [scanner(false), scanner(true)];
const ENTRY_BY_NAME = new Map(TOOL_VOCABULARY.map((entry) => [entry.name, entry]));
const PARENTS = new Map();
for (const entry of TOOL_VOCABULARY) for (const member of entry.implies || []) PARENTS.set(member, [...(PARENTS.get(member) || []), entry.name]);

function entryOf(surface) {
  return TOOL_VOCABULARY.find((entry) => entry.exact.some((pattern) => pattern.test(surface)));
}

/**
 * The vocabulary tools a text names, with their position, longest name first
 * where two overlap.
 * @returns {Array<{token:string, name:string, index:number, length:number}>}
 */
export function vocabularyTools(text) {
  const source = String(text || '');
  const hits = [];
  for (const pattern of SCANNERS) {
    for (const match of source.matchAll(pattern)) {
      const entry = entryOf(match[0]);
      if (entry) hits.push({ token: match[0], name: entry.name, index: match.index, length: match[0].length });
    }
  }
  hits.sort((left, right) => left.index - right.index || right.length - left.length);
  const out = [];
  for (const hit of hits) {
    const last = out[out.length - 1];
    if (last && hit.index < last.index + last.length) continue;
    out.push(hit);
  }
  return out;
}

/** Whether a raw text names the tool by any of its forms, or names a suite that includes it. */
export function mentionsVocabularyTool(rawText, name) {
  const text = String(rawText || '');
  const named = (entry) => Boolean(entry) && entry.patterns.some((pattern) => pattern.test(text));
  return named(ENTRY_BY_NAME.get(name)) || (PARENTS.get(name) || []).some((parent) => named(ENTRY_BY_NAME.get(parent)));
}
