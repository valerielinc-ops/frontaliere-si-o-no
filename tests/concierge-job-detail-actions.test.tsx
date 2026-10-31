import React from 'react';
import fs from 'node:fs';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const source = fs.readFileSync('components/community/JobBoard.tsx', 'utf8');
const tree = ts.createSourceFile('JobBoard.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const formBranches: string[] = [];
let sidebarButton = '';
function visit(node: ts.Node) {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === 'PublisherApplyForm') {
    let parent: ts.Node | undefined = node.parent;
    while (parent && !ts.isJsxExpression(parent)) parent = parent.parent;
    if (parent && ts.isJsxExpression(parent) && parent.expression) formBranches.push(parent.expression.getText(tree));
  }
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === 'button'
    && node.getText(tree).includes("'jobBoard.adviceCta'")) sidebarButton = node.getText(tree);
  ts.forEachChild(node, visit);
}
visit(tree);

// Render the component's own JSX branches, rather than reproducing its guards.
// The publisher form is a boundary spy: mounting it exposes the direct-send
// path that a concierge proposal must never offer before acceptance.
function renderBranch(expression: string, active: boolean, applyMode: string, labelKey = 'jobBoard.concierge.accept') {
  const publisherMounted = vi.fn();
  const directSend = vi.fn();
  const handleApply = vi.fn();
  const selectedJob = { id: 'fixture-job', publisherJobId: 'fixture-publisher-job', publisherUid: 'fixture-publisher', title: 'IT Manager', slug: 'it-manager', applyMode };
  const PublisherApplyForm = () => {
    publisherMounted();
    return <form aria-label="Direct publisher application" onSubmit={event => { event.preventDefault(); directSend(); }}><button>Send directly</button></form>;
  };
  const bindings = {
    React, PublisherApplyForm, selectedJob, conciergeAction: { active, labelKey },
    isInHouseApply: applyMode === 'in_house' || applyMode === 'forward_email',
    handleApply, t: (key: string) => key, renderApplicationIntentConsent: () => null,
    rewardedCtaDisclosure: null,
  };
  const compiled = ts.transpileModule(`return (${expression});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, module: ts.ModuleKind.None },
  }).outputText;
  render(new Function(...Object.keys(bindings), compiled)(...Object.values(bindings)));
  return { publisherMounted, directSend, handleApply, selectedJob };
}
afterEach(cleanup);

describe('concierge job detail application actions', () => {
  it('covers both supported publisher form render branches and the sidebar', () => {
    expect(formBranches).toHaveLength(2);
    expect(sidebarButton).not.toBe('');
  });

  it.each(['in_house', 'forward_email'])('never mounts a direct %s form for a concierge proposal', applyMode => {
    for (const branch of formBranches) {
      const { publisherMounted, directSend } = renderBranch(branch, true, applyMode);
      expect(screen.queryByRole('form', { name: 'Direct publisher application' })).toBeNull();
      expect(publisherMounted).not.toHaveBeenCalled();
      expect(directSend).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it.each(['in_house', 'forward_email'])('preserves the ordinary %s publisher form', applyMode => {
    for (const branch of formBranches) {
      const { publisherMounted, directSend, handleApply } = renderBranch(branch, false, applyMode);
      fireEvent.submit(screen.getByRole('form', { name: 'Direct publisher application' }));
      expect(publisherMounted).toHaveBeenCalledTimes(1);
      expect(directSend).toHaveBeenCalledTimes(1);
      expect(handleApply).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it.each(['jobBoard.concierge.accept', 'jobBoard.concierge.openChild', 'jobBoard.concierge.backToService'])('uses %s in the sidebar and the common application handler', labelKey => {
    const { handleApply, selectedJob } = renderBranch(sidebarButton, true, 'portal', labelKey);
    fireEvent.click(screen.getByRole('button', { name: labelKey }));
    expect(handleApply).toHaveBeenCalledExactlyOnceWith(selectedJob);
  });

  it('preserves the ordinary sidebar action', () => {
    const { handleApply, selectedJob } = renderBranch(sidebarButton, false, 'portal');
    fireEvent.click(screen.getByRole('button', { name: 'jobBoard.adviceCta' }));
    expect(handleApply).toHaveBeenCalledExactlyOnceWith(selectedJob);
  });
});
