// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SwissBubbleMap, CantonJobsData } from '../components/community/SwissBubbleMap';

afterEach(() => {
  cleanup();
});

const mockData: CantonJobsData[] = [
  { cantonCode: 'TI', name: 'Ticino', count: 1250 },
  { cantonCode: 'GR', name: 'Grigioni', count: 320 },
  { cantonCode: 'ZH', name: 'Zurigo', count: 4800 },
  { cantonCode: 'GE', name: 'Ginevra', count: 950 },
  { cantonCode: 'BS', name: 'Basilea', count: 600 },
  { cantonCode: 'VS', name: 'Vallese', count: 0 }, // 0 offerte: deve essere escluso dal rendering bolla
];

describe('SwissBubbleMap Component', () => {
  it('renderizza la mappa SVG con i confini e le bolle dei cantoni attivi', () => {
    const onSelect = vi.fn();
    render(<SwissBubbleMap data={mockData} onSelectCanton={onSelect} />);

    expect(screen.getByRole('region', { name: /mappa offerte per cantone svizzero/i })).toBeTruthy();
    expect(screen.getByTestId('canton-bubble-TI')).toBeTruthy();
    expect(screen.getByTestId('canton-bubble-GR')).toBeTruthy();
    expect(screen.getByTestId('canton-bubble-ZH')).toBeTruthy();
    expect(screen.getByTestId('canton-bubble-GE')).toBeTruthy();
    expect(screen.getByTestId('canton-bubble-BS')).toBeTruthy();
    // Il Vallese ha 0 offerte, quindi non deve renderizzare una bolla cliccabile
    expect(screen.queryByTestId('canton-bubble-VS')).toBeNull();
  });

  it('calcola il raggio proporzionalmente alla radice quadrata del volume', () => {
    const onSelect = vi.fn();
    render(<SwissBubbleMap data={mockData} onSelectCanton={onSelect} />);

    const zhBubble = screen.getByTestId('canton-bubble-ZH');
    const grBubble = screen.getByTestId('canton-bubble-GR');

    const zhCircles = zhBubble.querySelectorAll('circle');
    const grCircles = grBubble.querySelectorAll('circle');

    // Il secondo cerchio è quello primario
    const zhRadius = parseFloat(zhCircles[1].getAttribute('r') || '0');
    const grRadius = parseFloat(grCircles[1].getAttribute('r') || '0');

    // Zurigo (4800) deve avere un raggio significativamente maggiore di Grigioni (320)
    expect(zhRadius).toBeGreaterThan(grRadius);
    // Zurigo (maxJobs) deve raggiungere il maxR (32)
    expect(zhRadius).toBeCloseTo(32, 0);
  });

  it('notifica la selezione del cantone al click', () => {
    const onSelect = vi.fn();
    render(<SwissBubbleMap data={mockData} onSelectCanton={onSelect} />);

    const tiBubble = screen.getByTestId('canton-bubble-TI');
    fireEvent.click(tiBubble);

    expect(onSelect).toHaveBeenCalledWith('TI');
  });

  it('deseleziona il cantone (toggle off) se già selezionato', () => {
    const onSelect = vi.fn();
    render(<SwissBubbleMap data={mockData} selectedCanton="TI" onSelectCanton={onSelect} />);

    const tiBubble = screen.getByTestId('canton-bubble-TI');
    fireEvent.click(tiBubble);

    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('supporta navigazione da tastiera accessibile con tasto Invio e Spazio', () => {
    const onSelect = vi.fn();
    render(<SwissBubbleMap data={mockData} onSelectCanton={onSelect} />);

    const grBubble = screen.getByTestId('canton-bubble-GR');
    fireEvent.keyDown(grBubble, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('GR');

    fireEvent.keyDown(grBubble, { key: ' ' });
    expect(onSelect).toHaveBeenCalledWith('GR');
  });

  it('mostra il tooltip con nome cantone e conteggio formattato al passaggio del mouse', () => {
    const onSelect = vi.fn();
    render(<SwissBubbleMap data={mockData} onSelectCanton={onSelect} />);

    expect(screen.queryByTestId('canton-tooltip')).toBeNull();

    const tiBubble = screen.getByTestId('canton-bubble-TI');
    fireEvent.mouseEnter(tiBubble);

    const tooltip = screen.getByTestId('canton-tooltip');
    expect(tooltip).toBeTruthy();
    expect(tooltip.textContent).toContain('Ticino');
    expect(tooltip.textContent).toMatch(/1['.]?250 offerte/);

    fireEvent.mouseLeave(tiBubble);
    expect(screen.queryByTestId('canton-tooltip')).toBeNull();
  });
});
