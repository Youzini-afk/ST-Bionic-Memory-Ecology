import assert from 'node:assert/strict';

import {
  buildPersistedReuseRecallInput,
  isActiveRecallInputSource,
  isNoNewUserGenerationType,
  isTrustedUserFloorRecallSource,
  normalizeRecallGenerationType,
  normalizeRecallTargetUserMessageIndex,
  normalizeRecallTextForRuntime,
} from '../retrieval/recall-controller.js';

assert.equal(normalizeRecallGenerationType(' regenerate '), 'regenerate');
assert.equal(normalizeRecallGenerationType(''), 'normal');
assert.equal(normalizeRecallGenerationType(null), 'normal');

assert.equal(normalizeRecallTargetUserMessageIndex(3.9), 3);
assert.equal(normalizeRecallTargetUserMessageIndex(Number.NaN), null);
assert.equal(normalizeRecallTargetUserMessageIndex('3'), null);

assert.equal(normalizeRecallTextForRuntime(null, ' a\r\nb '), 'a\nb');
assert.equal(
  normalizeRecallTextForRuntime({ normalizeRecallInputText: (value) => `x:${String(value).trim()}` }, ' a '),
  'x:a',
);

for (const source of [
  'send-intent',
  'generation-started-send-intent',
  'generation-started-textarea',
  'host-generation-lifecycle',
  'textarea-live',
  'planner-handoff',
]) {
  assert.equal(isActiveRecallInputSource(source), true, source);
}
assert.equal(isActiveRecallInputSource('chat-last-user'), false);

for (const generationType of ['swipe', 'regenerate', 'continue', 'history']) {
  assert.equal(isNoNewUserGenerationType(generationType), true, generationType);
}
assert.equal(isNoNewUserGenerationType('normal'), false);

for (const source of [
  'chat-last-user',
  'chat-latest-user',
  'chat-tail-user',
  'message-sent',
  'persisted-user-floor',
]) {
  assert.equal(isTrustedUserFloorRecallSource(source), true, source);
}
assert.equal(isTrustedUserFloorRecallSource('textarea-live'), false);

{
  const recallInput = {
    source: 'chat-last-user',
    sourceLabel: '历史最后用户楼层',
    reason: 'chat-tail-fallback',
    authoritativeInputUsed: false,
    boundUserFloorText: ' fallback floor ',
    deliveryMode: 'deferred',
  };
  const record = {
    authoritativeInputUsed: true,
    boundUserFloorText: ' persisted floor ',
  };
  const result = buildPersistedReuseRecallInput(recallInput, record, {
    normalizeRecallInputText: (value) => String(value || '').trim().toUpperCase(),
  });
  assert.equal(result.source, 'persisted-user-floor');
  assert.equal(result.sourceLabel, '复用用户楼层召回');
  assert.equal(result.reason, 'persisted-user-floor-reuse');
  assert.equal(result.authoritativeInputUsed, true);
  assert.equal(result.boundUserFloorText, 'PERSISTED FLOOR');
  assert.equal(result.deliveryMode, 'deferred');
}

{
  const result = buildPersistedReuseRecallInput(
    { authoritativeInputUsed: true, boundUserFloorText: 'input\r\ntext' },
    {},
    null,
  );
  assert.equal(result.authoritativeInputUsed, true);
  assert.equal(result.boundUserFloorText, 'input\ntext');
}

console.log('recall-controller-helpers tests passed');
