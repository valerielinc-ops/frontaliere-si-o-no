// @vitest-environment jsdom
import React, { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import JobBoardQuickFilterChips, {
 toggleQuickFilterChip,
 type JobBoardQuickFilterChip,
} from '@/components/community/JobBoardQuickFilterChips';

const Icon = () => null;

function chip(id: string, group: string, active = false, action = () => {}): JobBoardQuickFilterChip {
 return { id, group, icon: Icon, label: id, active, action };
}

describe('toggleQuickFilterChip', () => {
 it('switches the active chip inside its group and leaves other groups alone', () => {
 const next = toggleQuickFilterChip(
 [chip('lugano', 'location', false), chip('mendrisio', 'location', true), chip('today', 'date', true)],
 'lugano',
 );
 expect(next.map((c) => [c.id, c.active])).toEqual([['lugano', true], ['mendrisio', false], ['today', true]]);
 });

 it('turns an active chip off without touching its siblings', () => {
 const next = toggleQuickFilterChip([chip('lugano', 'location', true), chip('today', 'date', true)], 'lugano');
 expect(next.map((c) => c.active)).toEqual([false, true]);
 });
});

describe('JobBoardQuickFilterChips', () => {
 function Harness() {
 const [location, setLocation] = useState('all');
 return (
 <JobBoardQuickFilterChips
 chips={['lugano', 'mendrisio'].map((id) => chip(id, 'location', location === id, () => {
 setLocation((prev) => (prev === id ? 'all' : id));
 }))}
 />
 );
 }

 it('runs the parent filter update and ends on the committed state', async () => {
 render(<Harness />);
 await act(async () => {
 fireEvent.click(screen.getByRole('button', { name: 'lugano' }));
 });
 expect(screen.getByRole('button', { name: 'lugano' }).getAttribute('aria-pressed')).toBe('true');
 expect(screen.getByRole('button', { name: 'mendrisio' }).getAttribute('aria-pressed')).toBe('false');

 await act(async () => {
 fireEvent.click(screen.getByRole('button', { name: 'lugano' }));
 });
 expect(screen.getByRole('button', { name: 'lugano' }).getAttribute('aria-pressed')).toBe('false');
 });
});
