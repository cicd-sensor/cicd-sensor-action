var __webpack_exports__ = {};
// GitHub registers this action's post when pre runs. With the action first
// in the job, its post runs after posts registered by later actions in either
// pre or main. No agent is started here; a skipped main owns nothing.
console.log('cicd-sensor: registered post-job finalization');

