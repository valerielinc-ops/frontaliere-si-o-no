import {
  boundRunnerEvent,
  MAX_RUNNER_EVENT_BYTES,
  MAX_RUNNER_EVENT_QUESTION_DETAILS,
  questionDetailsForEvent,
} from './lib/question-details.mjs';

const maxText = '😀'.repeat(120);
const maxOption = index => `${'😀'.repeat(79)}${String(index).padStart(2, '0')}`;
const optionList = Array.from({ length: 40 }, (_, index) => maxOption(index));
const questions = Array.from({ length: MAX_RUNNER_EVENT_QUESTION_DETAILS }, (_, index) => ({
  id: `question_${String(index).padStart(2, '0')}`,
  source: 'portal', question: maxText, applicationQuestion: maxText,
  context: maxText, section: maxText, autocomplete: '😀'.repeat(50), type: 'choice',
  options: optionList, applicationOptions: optionList,
}));
const envelope = {
  type: 'submit_needs_candidate', round: 1, mode: 'submit', createdAt: 0, runId: 'size-probe',
  questions: questions.map(({ id }) => ({ id })), documents: [],
};
const details = questionDetailsForEvent(questions, () => '😀'.repeat(500));
const event = boundRunnerEvent({ ...envelope, questionDetails: details });
const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
const result = {
  productionQuestionCount: MAX_RUNNER_EVENT_QUESTION_DETAILS,
  optionEntriesPerList: 40,
  optionListsPerQuestion: 2,
  descriptorsRetained: event.questionDetails?.length || 0,
  payloadBytes: bytes,
  configuredLimitBytes: MAX_RUNNER_EVENT_BYTES,
  withinLimit: bytes <= MAX_RUNNER_EVENT_BYTES,
};
console.log(JSON.stringify(result, null, 2));
if (!result.withinLimit) process.exitCode = 1;
