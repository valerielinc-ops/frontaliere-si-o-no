// career-ops liveness gate, run before drafting and again right before submitting. It lives in the functions'
// sources, where the functions run it too: functions/src/assistedApplicationLiveness.js.
export { checkPostingLiveness } from '../../../functions/src/assistedApplicationLiveness.js';
