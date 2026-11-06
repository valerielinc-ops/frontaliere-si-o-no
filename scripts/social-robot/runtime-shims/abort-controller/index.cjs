'use strict';

const AbortController = globalThis.AbortController;
const AbortSignal = globalThis.AbortSignal;

if (typeof AbortController !== 'function' || typeof AbortSignal !== 'function') {
  throw new Error('social-robot requires a Node runtime with native AbortController support');
}

module.exports = AbortController;
module.exports.AbortController = AbortController;
module.exports.AbortSignal = AbortSignal;
module.exports.default = AbortController;
