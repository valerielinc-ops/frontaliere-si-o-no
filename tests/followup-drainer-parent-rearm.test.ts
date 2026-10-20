/**
 * Riarmo del padre dopo una riapertura del monitor e una decomposizione
 * esaurita. Le quattro fixture sono i casi misurati nella issue sito 11923.
 *
 * Il test è deliberatamente puro: nessun `gh`, nessun mock e nessun DOM. La
 * decisione deve restare riusabile dal PARENT-CLOSE senza duplicare la logica
 * nel drainer.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PARENT_REARM_MAX_PER_WINDOW,
  DEFAULT_PARENT_REARM_WINDOW_DAYS,
  PARENT_REARM_MARKER,
  decideParentRearm,
  parentRearmCommentBody,
} from '../scripts/ci/lib/parent-close-recurrence.mjs';
import { normalizeIssuePage, snapshotIssueState } from '../scripts/ci/followup-drainer.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-06T20:00:00Z');

const reopenedBody = (number: number) =>
  `🔁 **Reopened** — ricorrenza del padre #${number}: la stessa condizione si è ripresentata.`;
const recurringBody = () => '🔁 Recurrence on workflow run.\n\n**Workflow:** Bing SEO closed loop — full sitemap tree';

const decomposedBody = (children: number[]) =>
  `## Decomposizione\n\n<!-- DECOMPOSED_INTO: ${children.join(' ')} -->`;

const closedChildren = (children: number[]) => children.map((number) => ({ number, state: 'CLOSED' }));

const realCases = [
  {
    number: 6504,
    children: [6918, 6919, 6920, 6921, 6922, 6923],
    decomposedAt: '2026-09-01T06:43:51Z',
    reopenedAt: '2026-10-04T11:15:56Z',
  },
  {
    number: 6317,
    children: [6765, 6766],
    decomposedAt: '2026-08-31T13:01:51Z',
    reopenedAt: '2026-10-05T10:51:50Z',
  },
  {
    number: 10120,
    children: [11438, 11439, 11440, 11441, 11442],
    decomposedAt: '2026-10-04T11:51:23Z',
    reopenedAt: '2026-10-06T13:39:40Z',
    recurrenceBody: recurringBody(),
  },
  {
    number: 5661,
    children: [6672, 6673, 6674],
    decomposedAt: '2026-08-30T06:07:04Z',
    reopenedAt: '2026-09-24T18:16:59Z',
  },
];

function commentsFor(parent: typeof realCases[number]) {
  return [
    { body: decomposedBody(parent.children), createdAt: parent.decomposedAt },
    {
      body: parent.recurrenceBody || reopenedBody(parent.number),
      createdAt: parent.reopenedAt,
    },
  ];
}

/** Una riga dell'endpoint REST `issues`, nella forma che GitHub restituisce. */
const restIssueRow = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `padre ${number}`,
  body: '',
  state: 'open',
  labels: [{ name: 'decomposed:1' }, { name: 'agent:triaged' }],
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-10-06T00:00:00Z',
  ...extra,
});

describe('PARENT-REARM: lo stato del padre arriva dallo snapshot fino alla decisione', () => {
  it('lo snapshot conserva lo stato e la decisione riarma con quello, senza valori scritti a mano', () => {
    // Il difetto misurato: i test puri passavano `parentState: 'OPEN'`, ma il
    // drainer lo prendeva dalla riga dello snapshot, che non lo portava. Qui il
    // valore fa lo stesso percorso della produzione.
    const parent = realCases[0];
    const page = normalizeIssuePage([restIssueRow(parent.number)]);
    expect(page?.rows).toHaveLength(1);
    const parentState = snapshotIssueState(page?.rows[0]);
    expect(parentState).toBe('open');

    expect(decideParentRearm({
      parentState,
      comments: commentsFor(parent),
      childStates: closedChildren(parent.children),
      now: NOW,
    })).toMatchObject({ action: 'rearm', reason: 'children-closed' });
  });

  it('una riga senza stato non diventa un padre aperto: il cablaggio rotto ha un nome suo', () => {
    const parent = realCases[0];
    const { state: _state, ...withoutState } = restIssueRow(parent.number);
    const page = normalizeIssuePage([withoutState]);
    expect(page?.rows).toHaveLength(1);
    expect(page?.rows[0]).not.toHaveProperty('state');
    expect(snapshotIssueState(page?.rows[0])).toBeNull();
    // La decisione pura resta fail-closed: e' il chiamante a dire perche'.
    expect(decideParentRearm({
      parentState: undefined,
      comments: commentsFor(parent),
      childStates: closedChildren(parent.children),
      now: NOW,
    })).toMatchObject({ action: 'skip', reason: 'unreadable' });
  });

  it('uno stato che non e\' una stringa rende malformata la pagina, non la issue aperta', () => {
    expect(normalizeIssuePage([restIssueRow(1, { state: 1 })])).toBeNull();
    expect(normalizeIssuePage([restIssueRow(1, { state: { name: 'open' } })])).toBeNull();
    expect(snapshotIssueState({ state: '' })).toBeNull();
    expect(snapshotIssueState(null)).toBeNull();
  });

  it('una issue chiusa non viene riarmata', () => {
    const parent = realCases[0];
    const page = normalizeIssuePage([restIssueRow(parent.number, { state: 'closed' })]);
    expect(decideParentRearm({
      parentState: snapshotIssueState(page?.rows[0]),
      comments: commentsFor(parent),
      childStates: closedChildren(parent.children),
      now: NOW,
    })).toMatchObject({ action: 'skip' });
  });
});

describe('PARENT-REARM: i quattro padri misurati rientrano una sola volta', () => {
  it('riarma ogni fixture quando tutte le figlie sono chiuse', () => {
    for (const parent of realCases) {
      const decision = decideParentRearm({
        parentState: 'OPEN',
        comments: commentsFor(parent),
        childStates: closedChildren(parent.children),
        now: NOW,
      });
      expect(decision, `padre #${parent.number}`).toMatchObject({
        action: 'rearm',
        reason: 'children-closed',
        reopenedAt: parent.reopenedAt,
        childNumbers: parent.children,
      });

      const after = [
        ...commentsFor(parent),
        {
          body: parentRearmCommentBody({
            reopenedAt: parent.reopenedAt,
            childNumbers: parent.children,
          }),
          createdAt: '2026-10-06T20:01:00Z',
        },
      ];
      expect(decideParentRearm({
        parentState: 'OPEN',
        comments: after,
        childStates: closedChildren(parent.children),
        now: NOW,
      }), `idempotenza #${parent.number}`).toMatchObject({
        action: 'skip',
        reason: 'already-rearmed',
      });
    }
  });

  it('riconosce il marker scritto nello stesso secondo della ricorrenza', () => {
    // I timestamp dei commenti hanno precisione al secondo: ricorrenza e marker
    // possono avere lo stesso istante. Il marker identifica comunque l'evento.
    const parent = realCases[0];
    const sameSecond = [
      ...commentsFor(parent),
      {
        body: parentRearmCommentBody({ reopenedAt: parent.reopenedAt, childNumbers: parent.children }),
        createdAt: parent.reopenedAt,
      },
    ];
    expect(decideParentRearm({
      parentState: 'OPEN',
      comments: sameSecond,
      childStates: closedChildren(parent.children),
      now: NOW,
    })).toMatchObject({ action: 'skip', reason: 'already-rearmed' });

    // Un marker datato prima della ricorrenza che dichiara non la copre.
    const before = [
      ...commentsFor(parent),
      {
        body: parentRearmCommentBody({ reopenedAt: parent.reopenedAt, childNumbers: parent.children }),
        createdAt: new Date(Date.parse(parent.reopenedAt) - 1000).toISOString(),
      },
    ];
    expect(decideParentRearm({
      parentState: 'OPEN',
      comments: before,
      childStates: closedChildren(parent.children),
      now: NOW,
    })).toMatchObject({ action: 'rearm', reason: 'children-closed' });
  });

  it('un marker nello stesso secondo copre la ricorrenza solo se viene dopo nel thread', () => {
    // Tutto nello stesso secondo: ricorrenza, marker di quella ricorrenza, e
    // una seconda ricorrenza. Il marker PRECEDE la seconda ricorrenza: non può
    // averla registrata. Con il solo confronto degli istanti la seconda
    // risultava «già riarmata» e il padre usciva senza che nessuno leggesse lo
    // stato delle figlie.
    const parent = realCases[0];
    const marker = {
      body: parentRearmCommentBody({ reopenedAt: parent.reopenedAt, childNumbers: parent.children }),
      createdAt: parent.reopenedAt,
    };
    const secondRecurrence = { body: reopenedBody(parent.number), createdAt: parent.reopenedAt };
    const markerBefore = [...commentsFor(parent), marker, secondRecurrence];

    const [openChild, ...rest] = parent.children;
    expect(decideParentRearm({
      parentState: 'OPEN',
      comments: markerBefore,
      childStates: [{ number: openChild, state: 'OPEN' }, ...closedChildren(rest)],
      now: NOW,
    })).toMatchObject({ action: 'skip', reason: 'child-open' });
    expect(decideParentRearm({
      parentState: 'OPEN',
      comments: markerBefore,
      childStates: closedChildren(parent.children),
      now: NOW,
    })).toMatchObject({ action: 'rearm', reason: 'children-closed' });

    // Lo stesso marker, scritto DOPO la seconda ricorrenza, la copre.
    const markerAfter = [...commentsFor(parent), secondRecurrence, marker];
    expect(decideParentRearm({
      parentState: 'OPEN',
      comments: markerAfter,
      childStates: null,
      now: NOW,
    })).toMatchObject({ action: 'skip', reason: 'already-rearmed' });
  });

  it('a parità di secondo decide l\'ultima decomposizione, come nel PARENT-CLOSE', () => {
    // Due marker DECOMPOSED_INTO nello stesso secondo: il secondo aggiunge una
    // figlia ancora aperta. `decomposedChildNumbers` usa l'ultimo commento; la
    // decisione di riarmo deve guardare lo stesso insieme, non il primo.
    const parent = realCases[1];
    const extraChild = 9999;
    const comments = [
      { body: decomposedBody(parent.children), createdAt: parent.decomposedAt },
      { body: decomposedBody([...parent.children, extraChild]), createdAt: parent.decomposedAt },
      { body: reopenedBody(parent.number), createdAt: parent.reopenedAt },
    ];
    const decision = decideParentRearm({
      parentState: 'OPEN',
      comments,
      childStates: [...closedChildren(parent.children), { number: extraChild, state: 'OPEN' }],
      now: NOW,
    });
    expect(decision).toMatchObject({ action: 'skip', reason: 'child-open' });
  });

  it('una ricorrenza nello stesso secondo della decomposizione conta solo se viene dopo nel thread', () => {
    const parent = realCases[1];
    const after = [
      { body: decomposedBody(parent.children), createdAt: parent.decomposedAt },
      { body: reopenedBody(parent.number), createdAt: parent.decomposedAt },
    ];
    expect(decideParentRearm({
      parentState: 'OPEN',
      comments: after,
      childStates: closedChildren(parent.children),
      now: NOW,
    })).toMatchObject({ action: 'rearm', reason: 'children-closed' });

    const before = [
      { body: reopenedBody(parent.number), createdAt: parent.decomposedAt },
      { body: decomposedBody(parent.children), createdAt: parent.decomposedAt },
    ];
    expect(decideParentRearm({
      parentState: 'OPEN',
      comments: before,
      childStates: closedChildren(parent.children),
      now: NOW,
    })).toMatchObject({ action: 'skip', reason: 'not-reopened' });
  });

  it('non riarma se almeno una figlia è ancora aperta', () => {
    const parent = realCases[0];
    const states = closedChildren(parent.children);
    states[states.length - 1] = { number: parent.children[parent.children.length - 1], state: 'OPEN' };
    expect(decideParentRearm({
      parentState: 'OPEN',
      comments: commentsFor(parent),
      childStates: states,
      now: NOW,
    })).toMatchObject({ action: 'skip', reason: 'child-open' });
  });

  it('non riarma oltre il tetto per issue nella finestra e lo segnala', () => {
    const parent = realCases[1];
    const comments = [
      ...commentsFor(parent),
      ...[1, 2].map((index) => ({
        body: `${PARENT_REARM_MARKER} reopened-at=2026-10-0${index}T08:00:00Z -->`,
        createdAt: `2026-10-0${index}T08:01:00Z`,
      })),
    ];
    expect(decideParentRearm({
      parentState: 'OPEN',
      comments,
      childStates: closedChildren(parent.children),
      now: NOW,
    })).toMatchObject({ action: 'skip', reason: 'window-cap' });
  });

  it('createdAt mancante o stato figlia illeggibile resta fail-closed', () => {
    const parent = realCases[2];
    expect(decideParentRearm({
      parentState: 'OPEN',
      comments: [{ body: reopenedBody(parent.number), createdAt: parent.reopenedAt }],
      childStates: closedChildren(parent.children),
      now: NOW,
    })).toMatchObject({ action: 'skip', reason: 'unreadable' });

    expect(decideParentRearm({
      parentState: 'OPEN',
      comments: [
        { body: decomposedBody(parent.children), createdAt: parent.decomposedAt },
        { body: reopenedBody(parent.number) },
      ],
      childStates: closedChildren(parent.children),
      now: NOW,
    })).toMatchObject({ action: 'skip', reason: 'unreadable' });

    expect(decideParentRearm({
      parentState: 'OPEN',
      comments: [
        ...commentsFor(parent),
        { body: '<!-- PARENT_REARM: malformed -->', createdAt: '2026-10-06T19:00:00Z' },
      ],
      childStates: closedChildren(parent.children),
      now: NOW,
    })).toMatchObject({ action: 'skip', reason: 'unreadable' });

    expect(decideParentRearm({
      parentState: 'OPEN',
      comments: commentsFor(parent),
      childStates: null,
      now: NOW,
    })).toMatchObject({ action: 'skip', reason: 'unreadable' });
  });

  it('una decomposizione successiva restituisce autorità al PARENT-CLOSE', () => {
    const parent = realCases[3];
    const comments = [
      ...commentsFor(parent),
      {
        body: parentRearmCommentBody({
          reopenedAt: parent.reopenedAt,
          childNumbers: parent.children,
        }),
        createdAt: '2026-09-24T19:00:00Z',
      },
      {
        body: decomposedBody([7001, 7002]),
        createdAt: '2026-09-25T08:00:00Z',
      },
    ];
    expect(decideParentRearm({
      parentState: 'OPEN',
      comments,
      childStates: closedChildren([7001, 7002]),
      now: NOW,
    })).toMatchObject({ action: 'skip', reason: 'not-reopened' });
  });
});

describe('PARENT-REARM: default prudente', () => {
  it('espone una finestra di 30 giorni e due riarmi per issue', () => {
    expect(DEFAULT_PARENT_REARM_WINDOW_DAYS).toBe(30);
    expect(DEFAULT_PARENT_REARM_MAX_PER_WINDOW).toBe(2);
    expect(DEFAULT_PARENT_REARM_WINDOW_DAYS * DAY_MS).toBe(30 * DAY_MS);
  });
});
