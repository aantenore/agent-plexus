import { isDeepStrictEqual } from 'node:util';
import type { JsonSchema } from './adapter.ts';
import { isPlainObject } from './util.ts';

export interface Problem {
  path: string;
  message: string;
}

export const formatProblem = (p: Problem): string => `${p.path}: ${p.message}`;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer';
  return typeof value;
}

const matchesType = (expected: string, actual: string) => expected === actual || (expected === 'number' && actual === 'integer');

/** Validates a value against the JsonSchema subset of adapter.ts; one problem per violation, with its path. */
export function validate(value: unknown, schema: JsonSchema, path = '$'): Problem[] {
  const out: Problem[] = [];
  check(value, schema, path, out);
  return out;
}

function check(value: unknown, schema: JsonSchema, path: string, out: Problem[]): void {
  if (schema.oneOf && schema.oneOf.filter((s) => validate(value, s, path).length === 0).length !== 1) {
    out.push({ path, message: 'must match exactly one allowed shape' });
    return;
  }
  if (schema.type && !matchesType(schema.type, typeOf(value))) {
    out.push({ path, message: `expected ${schema.type}, got ${typeOf(value)}` });
    return;
  }
  if (schema.enum && !schema.enum.some((e) => isDeepStrictEqual(e, value))) {
    out.push({ path, message: `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}` });
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) out.push({ path, message: `must be >= ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) out.push({ path, message: `must be <= ${schema.maximum}` });
  }
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
    out.push({ path, message: `shorter than ${schema.minLength}` });
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => check(item, schema.items!, `${path}[${i}]`, out));
  if (isPlainObject(value)) checkObject(value, schema, path, out);
}

function checkObject(value: Record<string, unknown>, schema: JsonSchema, path: string, out: Problem[]): void {
  for (const key of schema.required ?? []) {
    if (value[key] === undefined) out.push({ path: `${path}.${key}`, message: 'required' });
  }
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue;
    const known = schema.properties?.[key];
    if (known) check(v, known, `${path}.${key}`, out);
    else if (schema.additionalProperties === false) out.push({ path: `${path}.${key}`, message: 'unknown property' });
    else if (isPlainObject(schema.additionalProperties)) check(v, schema.additionalProperties as JsonSchema, `${path}.${key}`, out);
  }
}
