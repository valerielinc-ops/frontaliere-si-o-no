/**
 * Interactive Interview Coach & Roleplay Simulator,
 * ported from ai-job-search interview prep roleplay framework (MIT).
 *
 * Provides a conversational mock interview experience for cross-border candidates
 * applying in Switzerland (Ticino, Grigioni, Zurigo, Basilea):
 * - Multiple interviewer personas (Recruiter, Hiring Manager, Technical Peer).
 * - Rigorous evaluation of candidate answers against the STAR+R framework (Situation, Task, Action, Result, Reflection).
 * - Enforces the Honesty Rule: flags fabricated experience and coaches transparent "gap bridging".
 * - Suggests polished Swiss-market formulations and selects the next progressive question.
 */

import { lookupSalaryBenchmark, formatSalaryInterviewBriefing } from './salaryBenchmarkService.js';
import { formatCompanyPromptContext } from './companyResearchService.js';

export const INTERVIEWER_PERSONAS = Object.freeze({
  recruiter: {
    id: 'recruiter',
    title: 'Responsabile Risorse Umane (HR Recruiter)',
    focus: 'Motivazione, permesso di lavoro G / frontaliere, pendolarismo, preavviso, inquadramento salariale e fit culturale.',
    tone: 'Accogliente, professionale, attento all\'affidabilità e alla stabilità del candidato.',
    firstQuestion: 'Buongiorno e benvenuto. Per iniziare, potrebbe farmi una breve panoramica del suo percorso professionale e spiegarmi cosa l\'ha spinta a candidarsi per questa posizione in Svizzera?',
  },
  hiring_manager: {
    id: 'hiring_manager',
    title: 'Responsabile di Reparto / Team Lead (Hiring Manager)',
    focus: 'Competenze tecniche, gestione degli imprevisti, priorità nei primi 90 giorni, leadership e impatto sui risultati.',
    tone: 'Diretto, orientato ai risultati e alla qualità svizzera, analitico.',
    firstQuestion: 'Piacere di conoscerla. Entrando subito nel vivo: qual è stato il progetto tecnicamente più complesso che ha guidato recentemente e quale impatto misurabile ha prodotto per l\'azienda?',
  },
  peer: {
    id: 'peer',
    title: 'Senior Specialist / Tecnico del Team (Peer Reviewer)',
    focus: 'Approccio pratico al lavoro quotidiano, qualità del codice/processo, code review, collaborazione e troubleshooting.',
    tone: 'Collaborativo, pragmatico, focalizzato su strumenti e dettagli operativi.',
    firstQuestion: 'Ciao! Nel nostro team diamo grande importanza all\'affidabilità e alla manutenibilità. Quando ti trovi davanti a un debito tecnico o a un bug critico in produzione, come imposti la risoluzione e la prevenzione?',
  },
});

export const STAR_CRITERIA = Object.freeze([
  { key: 'situation', label: 'Situazione', description: 'Contesto chiaro del progetto o problema aziendale' },
  { key: 'task', label: 'Compito', description: 'Obiettivo specifico e responsabilità diretta del candidato' },
  { key: 'action', label: 'Azione', description: 'Azioni concrete intraprese, strumenti e decisioni personali' },
  { key: 'result', label: 'Risultato', description: 'Esito misurabile, metriche quantitative e impatto reale' },
  { key: 'reflection', label: 'Riflessione', description: 'Cosa si è appreso o cosa si farebbe diversamente' },
]);

/**
 * Initializes a new mock interview session.
 * @param {object} params
 * @param {string} params.companyName
 * @param {string} params.roleTitle
 * @param {string} [params.canton='TI']
 * @param {object} params.candidateProfile
 * @param {string} [params.postingText='']
 * @param {object} [params.companyResearch=null]
 * @param {'recruiter'|'hiring_manager'|'peer'} [params.persona='hiring_manager']
 * @returns {object}
 */
export function createInterviewSession({
  companyName,
  roleTitle,
  canton = 'TI',
  candidateProfile,
  postingText = '',
  companyResearch = null,
  persona = 'hiring_manager',
}) {
  const chosenPersona = INTERVIEWER_PERSONAS[persona] || INTERVIEWER_PERSONAS.hiring_manager;
  const salaryBenchmark = lookupSalaryBenchmark({ roleTitle, canton });
  const salaryBriefing = formatSalaryInterviewBriefing(salaryBenchmark, roleTitle);

  return {
    sessionId: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    status: 'active',
    createdAt: Date.now(),
    companyName,
    roleTitle,
    canton,
    persona: chosenPersona,
    salaryBenchmark,
    salaryBriefing,
    candidateProfile,
    postingText,
    companyResearch,
    turns: [
      {
        speaker: 'interviewer',
        personaId: chosenPersona.id,
        question: chosenPersona.firstQuestion,
        timestamp: Date.now(),
      },
    ],
  };
}

/**
 * Evaluates candidate answer and produces constructive coaching feedback + next question.
 * @param {object} params
 * @param {string} params.currentQuestion
 * @param {string} params.candidateAnswer
 * @param {object} params.session
 * @returns {object}
 */
export function evaluateCandidateTurn({
  currentQuestion,
  candidateAnswer,
  session,
}) {
  const answer = String(candidateAnswer || '').trim();
  const wordCount = answer.split(/\s+/).filter(Boolean).length;

  const starScores = {
    situation: answer.length > 30 ? 20 : 10,
    task: /obiettivo|responsab|compito|dovevo|incaricat/i.test(answer) ? 20 : 10,
    action: /ho (utilizzato|guidato|creato|sviluppato|ottimizzato|implementato|risolto)/i.test(answer) ? 20 : 10,
    result: /\b(\d+%|\d+x|\d+\s*(euro|chf|clienti|utenti|giorni|ore|mesi)|migliorato|ridotto|aumentato)\b/i.test(answer) ? 20 : 5,
    reflection: /imparato|appreso|lezione|diversamente|futuro|retrospettiva/i.test(answer) ? 20 : 10,
  };

  const totalScore = Object.values(starScores).reduce((a, b) => a + b, 0);

  const strengths = [];
  const improvements = [];

  if (starScores.action >= 20) {
    strengths.push('Buona enfasi sulle azioni concrete e sull\'uso di verbi attivi in prima persona.');
  }
  if (starScores.result >= 20) {
    strengths.push('Presenza di impatto misurabile / metriche quantitative (elemento molto apprezzato nei colloqui in Svizzera).');
  } else {
    improvements.push('Manca un risultato numerico o tangibile (es. "% di tempo risparmiato", "riduzione degli errori", "rispetto dei tempi di consegna").');
  }

  if (wordCount < 40) {
    improvements.push('La risposta è troppo sintetica: arricchisci con dettagli concreti sulla situazione e sul tuo ruolo specifico.');
  } else if (wordCount > 350) {
    improvements.push('La risposta è molto prolissa: punta a una durata di 90-120 secondi parlando, andando dritto al punto (headline result first).');
  }

  // Polish formulation suggestion
  const suggestedPolishing = `Inizia con il risultato principale ("Abbiamo migliorato l'affidabilità del sistema del 30%..."), poi spiega brevemente il contesto (Situazione), cosa ti è stato affidato (Task) e le scelte tecniche o metodologiche adottate (Azione).`;

  // Determine next question based on turn depth and persona
  const turnIndex = (session?.turns || []).length;
  let nextQuestion = '';

  if (session?.persona?.id === 'recruiter') {
    if (turnIndex <= 2) {
      nextQuestion = `Trattandosi di una posizione a ${session.companyName} (${session.canton}), come prevede di gestire il pendolarismo transfrontaliero e qual è il suo attuale periodo di preavviso?`;
    } else if (turnIndex <= 4) {
      nextQuestion = `Riguardo all'inquadramento economico, quali sono le sue aspettative salariali lorde annue in franchi svizzeri per questo ruolo?`;
    } else {
      nextQuestion = `Ha delle domande specifiche per noi sulla nostra cultura aziendale o sull'organizzazione del team?`;
    }
  } else {
    if (turnIndex <= 2) {
      nextQuestion = `Ci descriva una situazione in cui ha riscontrato un disaccordo tecnico o di priorità con un collega o responsabile: come lo ha affrontato e quale soluzione avete concordato?`;
    } else if (turnIndex <= 4) {
      nextQuestion = `Se dovesse entrare nel nostro team domani, quali sarebbero le sue priorità operative nei primi 30 e 90 giorni?`;
    } else {
      nextQuestion = `Quali aspetti della tecnologia o del modello di business di ${session.companyName} la stimolano maggiormente per la sua crescita professionale?`;
    }
  }

  const feedback = {
    turnScore: totalScore,
    wordCount,
    starBreakdown: starScores,
    strengths,
    improvements,
    suggestedPolishing,
    nextQuestion,
  };

  return feedback;
}

/**
 * Builds the LLM prompt for advanced open-ended interview feedback.
 * @param {object} params
 * @returns {{ systemPrompt: string, userText: string }}
 */
export function buildInterviewEvaluationPrompt({
  session,
  question,
  answer,
}) {
  const companyContext = formatCompanyPromptContext(session.companyResearch);

  const systemPrompt = `You are an expert executive interview coach specializing in the Swiss job market (Zurich, Ticino, Basel).
You coach candidates using the STAR+R methodology (Situation, Task, Action, Result, Reflection).

Evaluation Rules:
1. Result-first orientation: Praise answers that state the headline impact first.
2. Honesty & Gap Bridging: If the candidate does not have a tool, they must bridge ("adjacent skill + learning plan"), never bluff.
3. Culture check: Swiss companies value precision, humility, accountability, and punctuality.
4. Output must be constructive, actionable, and structured in Italian.`;

  const userText = `Candidate applying for: ${session.roleTitle} at ${session.companyName} (${session.canton})
Interviewer Persona: ${session.persona.title} (${session.persona.focus})

${companyContext ? `${companyContext}\n` : ''}
Question Asked:
"${question}"

Candidate Answer:
"${answer}"

Evaluate the answer: provide turnScore (0-100), STAR analysis, constructive strengths, areas for improvement, a polished rephrased version, and the next strategic question.`;

  return { systemPrompt, userText };
}
