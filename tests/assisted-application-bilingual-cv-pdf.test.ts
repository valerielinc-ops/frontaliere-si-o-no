import { describe, expect, it, vi } from 'vitest';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ getRemoteConfigValue: vi.fn(async () => '') }));

const { renderCvPdf } = await import('../functions/src/assistedApplicationPdfRenderer.js');

describe('renderCvPdf con template bilingue svizzero', () => {
  it('renderizza correttamente il CV in formato bilingue IT/DE con Typst', async () => {
    const doc = {
      name: 'Marco Rossi',
      language: 'it',
      headline: 'Senior Cloud Engineer',
      contact: ['marco.rossi@example.com', '+41 79 123 45 67', 'Lugano (TI)'],
      personalTitle: 'Dati personali e permesso',
      personal: [
        ['Permesso / Bewilligung', 'Permesso G Frontaliere'],
        ['Nazionalità / Staatsangehörigkeit', 'Italiana / Italienisch']
      ],
      sections: [
        {
          title: 'Esperienza professionale',
          items: [
            {
              title: 'Senior DevOps Specialist',
              org: 'Fintech Swiss SA',
              date: '2022 – presente',
              place: 'Lugano',
              text: 'Gestione infrastruttura cloud ibrida AWS e Kubernetes.',
              bullets: ['Riduzione downtime del 40%', 'Automazione pipeline CI/CD']
            }
          ]
        },
        {
          title: 'Istruzione e formazione',
          items: [
            {
              title: 'Laurea in Ingegneria Informatica',
              org: 'Politecnico di Milano',
              date: '2016 – 2019',
              place: 'Milano',
              text: 'Votazione 110/110'
            }
          ]
        },
        {
          title: 'Competenze linguistiche',
          pairs: [
            ['Italiano', 'Madrelingua'],
            ['Deutsch', 'B2 (Professionell)']
          ]
        },
        {
          title: 'Competenze tecniche',
          pairs: [
            ['Cloud & DevOps', 'Kubernetes, Docker, Terraform, AWS, Linux'],
            ['Linguaggi', 'Go, Python, TypeScript']
          ]
        }
      ]
    };

    const result = await renderCvPdf(doc, { mode: 'typst', bilingual: true });
    expect(result.renderer).toBe('typst');
    expect(result.pdf).toBeInstanceOf(Buffer);
    expect(result.pdf.length).toBeGreaterThan(1000);
    // Verifica header magico PDF %PDF
    expect(result.pdf.subarray(0, 4).toString()).toBe('%PDF');
  });
});
