import { describe, expect, it } from 'vitest';
import {
  buildInterviewEvaluationPrompt,
  createInterviewSession,
  evaluateCandidateTurn,
  INTERVIEWER_PERSONAS,
  STAR_CRITERIA,
} from '../functions/src/services/interviewCoachService.js';

describe('interviewCoachService', () => {
  it('creates an active interview session with salary benchmarks and recruiter persona', () => {
    const session = createInterviewSession({
      companyName: 'UBS Lugano',
      roleTitle: 'Senior Software Engineer',
      canton: 'TI',
      persona: 'recruiter',
      candidateProfile: {
        headline: 'Full-Stack Developer',
        skills: ['TypeScript', 'Node.js', 'React'],
      },
    });

    expect(session.status).toBe('active');
    expect(session.persona.id).toBe('recruiter');
    expect(session.persona.firstQuestion).toContain('Buongiorno');
    expect(session.salaryBenchmark.currency).toBe('CHF');
    expect(session.salaryBenchmark.annual.median).toBeGreaterThan(100000);
    expect(session.salaryBriefing.deferralScript).toContain('In questa fase iniziale sono concentrato');
    expect(session.turns).toHaveLength(1);
  });

  it('evaluates candidate answer against STAR criteria and rewards concrete metrics', () => {
    const session = createInterviewSession({
      companyName: 'Novartis',
      roleTitle: 'QA Specialist',
      canton: 'TI',
      persona: 'hiring_manager',
      candidateProfile: {},
    });

    // High quality STAR answer with numbers and reflection
    const goodAnswer = `
      Nel mio precedente ruolo presso Pharma SA, il nostro team doveva ridurre i tempi di rilascio dei lotti clinici (obiettivo principale).
      Ho guidato l'implementazione di un nuovo flusso di validazione automatizzato e formato 8 operatori.
      Grazie a questo intervento, abbiamo ridotto gli errori del 35% e accelerato i tempi di rilascio di 5 giorni lavorativi.
      In retrospettiva, avrei coinvolto il reparto di conformità fin dalla fase di prototipo per velocizzare l'approvazione finale.
    `;

    const feedback = evaluateCandidateTurn({
      currentQuestion: session.turns[0].question,
      candidateAnswer: goodAnswer,
      session,
    });

    expect(feedback.turnScore).toBeGreaterThanOrEqual(80);
    expect(feedback.strengths.length).toBeGreaterThan(0);
    expect(feedback.strengths.some((s) => s.includes('metriche'))).toBe(true);
    expect(feedback.nextQuestion).toBeTruthy();
  });

  it('identifies lack of metrics and suggests polishing for short answers', () => {
    const session = createInterviewSession({
      companyName: 'Bally',
      roleTitle: 'Web Developer',
      canton: 'TI',
      persona: 'hiring_manager',
      candidateProfile: {},
    });

    const weakAnswer = 'Ho fatto vari siti web e risolto problemi quando capitavano.';

    const feedback = evaluateCandidateTurn({
      currentQuestion: session.turns[0].question,
      candidateAnswer: weakAnswer,
      session,
    });

    expect(feedback.turnScore).toBeLessThan(70);
    expect(feedback.improvements.some((i) => i.includes('troppo sintetica'))).toBe(true);
    expect(feedback.improvements.some((i) => i.includes('risultato numerico'))).toBe(true);
  });

  it('builds an evaluation prompt containing company facts and persona', () => {
    const session = createInterviewSession({
      companyName: 'Swisscom',
      roleTitle: 'Cloud Architect',
      canton: 'ZH',
      persona: 'peer',
      candidateProfile: {},
      companyResearch: {
        legalName: 'Swisscom AG',
        industry: 'Telecom & Cloud',
        mission: 'Connettere la Svizzera con reti resilienti.',
      },
    });

    const { systemPrompt, userText } = buildInterviewEvaluationPrompt({
      session,
      question: 'Come gestisci i guasti distribuiti?',
      answer: 'Utilizzo pattern di circuit breaker e monitoraggio continuo.',
    });

    expect(systemPrompt).toContain('executive interview coach');
    expect(systemPrompt).toContain('STAR+R methodology');
    expect(userText).toContain('Swisscom AG');
    expect(userText).toContain('Cloud Architect');
  });
});
