import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JsonSchema } from '../src/adapter.ts';
import { validate } from '../src/schema.ts';

const schema: JsonSchema = {
  type: 'object',
  required: ['url'],
  properties: {
    url: { type: 'string', minLength: 1 },
    retries: { type: 'integer', minimum: 0, maximum: 5 },
    mode: { enum: ['a', 'b'] },
    tags: { type: 'array', items: { type: 'string' } },
    pick: { oneOf: [{ type: 'string' }, { type: 'number' }] },
  },
  additionalProperties: false,
};

test('valid options have no problems', () => {
  assert.deepEqual(validate({ url: 'x', retries: 2, mode: 'a', tags: ['t'], pick: 1 }, schema), []);
});

test('problems carry their path', () => {
  const problems = validate({ retries: 9, mode: 'c', tags: [1], extra: true, pick: true, url2: 1 }, schema, 'options');
  const paths = problems.map((p) => p.path).sort();
  assert.deepEqual(paths, ['options.extra', 'options.mode', 'options.pick', 'options.retries', 'options.tags[0]', 'options.url', 'options.url2']);
});

test('types: integer is a number, a float is not an integer, null is not an object', () => {
  assert.equal(validate(1, { type: 'number' }).length, 0);
  assert.equal(validate(1.5, { type: 'integer' }).length, 1);
  assert.equal(validate(null, { type: 'object' }).length, 1);
  assert.equal(validate([], { type: 'object' }).length, 1);
  assert.equal(validate('', { type: 'string', minLength: 1 }).length, 1);
});

test('additionalProperties as a schema validates the other values', () => {
  const s: JsonSchema = { type: 'object', additionalProperties: { type: 'number' } };
  assert.equal(validate({ a: 1, b: 'x' }, s).length, 1);
});
