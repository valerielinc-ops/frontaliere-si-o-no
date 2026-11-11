import { describe, expect, it } from 'vitest';
import { platformDefaultAnswer, platformQuestionTopic } from '../functions/src/assistedApplicationPlatformDefaults.js';
import { operationalDefaultAnswer, operationalQuestionTopic, withOperationalQuestionAnswers } from '../functions/src/assistedApplicationOperationalAnswers.js';

describe('history-row answer defaults', () => {
  it('does not suggest a platform start date or operational notice/workload in past rows', () => {
    const questions = [
      { id: 'work-start', label: 'Start Date', type: 'date', section: 'Work Experience' },
      { id: 'education-start', label: 'Data di inizio', type: 'date', group: { label: 'Formazione' } },
      { id: 'prior-relocation', label: 'Are you willing to relocate?', type: 'yes_no', section: 'Previous Employment' },
      { id: 'prior-notice', label: 'Notice period', type: 'text', section: 'Previous Employment' },
      { id: 'prior-workload', label: 'Desired workload', type: 'text', section: 'Esperienza professionale' },
    ];

    for (const question of questions) {
      expect(platformQuestionTopic(question), question.id).not.toBe('start_date');
      expect(platformDefaultAnswer(question), question.id).toBeNull();
      expect(operationalQuestionTopic(question), question.id).toBeNull();
      expect(operationalDefaultAnswer(question), question.id).toBeNull();
      expect(withOperationalQuestionAnswers([question]).defaults).not.toHaveProperty(question.id);
    }
  });
});
