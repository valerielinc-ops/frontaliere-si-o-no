'use strict';

if (typeof globalThis.AbortController !== 'function' || typeof globalThis.AbortSignal !== 'function') {
  throw new Error('social-robot requires a Node runtime with native AbortController support');
}

module.exports = {
  AbortController: globalThis.AbortController,
  AbortSignal: globalThis.AbortSignal,
};
