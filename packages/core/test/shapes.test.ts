import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memberLayerOf } from '../src/shapes.ts';

test('memberLayerOf: memberLayer first, else a layer that is neither a plexus layer nor host', () => {
  assert.equal(memberLayerOf({ code: 'error', layer: 'member', memberLayer: 'routing' }), 'routing');
  assert.equal(memberLayerOf({ code: 'error', layer: 'guardrails' }), 'guardrails');
  assert.equal(memberLayerOf({ code: 'error', layer: 'topology' }), undefined);
  assert.equal(memberLayerOf({ code: 'error', layer: 'host' }), undefined);
  assert.equal(memberLayerOf({ code: 'error', memberLayer: '' }), undefined);
  assert.equal(memberLayerOf(undefined), undefined);
});
