/** Validators for the shapes that cross the ports: each returns the problems found, empty when the value is sound. */
import { isLayer, RUN_STATUSES, type HopRecord } from '@agent-plexus/core';
import { extProblems } from './check.ts';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isCount = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Problems of an `AgentEntry`. */
export function entryProblems(entry: unknown): string[] {
  if (!isObject(entry)) return ['entry must be an object'];
  const out: string[] = [];
  if (!nonEmpty(entry.id)) out.push('id must be a non-empty string');
  if (!isString(entry.name)) out.push('name must be a string');
  if (!isString(entry.description)) out.push('description must be a string');
  if (!Array.isArray(entry.skills)) out.push('skills must be an array');
  else {
    entry.skills.forEach((s: unknown, i) => {
      if (!isObject(s)) return out.push(`skills[${i}] must be an object`);
      if (!nonEmpty(s.id)) out.push(`skills[${i}].id must be a non-empty string`);
      if (!isString(s.name)) out.push(`skills[${i}].name must be a string`);
      if (!isString(s.description)) out.push(`skills[${i}].description must be a string`);
      if (!Array.isArray(s.tags) || !s.tags.every(isString)) out.push(`skills[${i}].tags must be strings`);
    });
  }
  if (!isObject(entry.endpoint) || !nonEmpty(entry.endpoint.protocol)) out.push('endpoint.protocol must be a non-empty string');
  const trust = entry.trust;
  if (!isObject(trust)) out.push('trust must be an object');
  else {
    if (typeof trust.signed !== 'boolean') out.push('trust.signed must be a boolean');
    if (typeof trust.pinned !== 'boolean') out.push('trust.pinned must be a boolean');
    if (trust.keyId !== undefined && !isString(trust.keyId)) out.push('trust.keyId must be a string');
  }
  if (entry.audience !== undefined && !nonEmpty(entry.audience)) out.push('audience must be a non-empty string');
  if (entry.attrs !== undefined && !isObject(entry.attrs)) out.push('attrs must be an object');
  out.push(...extProblems(entry.ext));
  return out;
}

/** Problems of a `MemberResult`: a known status, a text output, a reason with a code unless completed, sound usage. */
export function resultProblems(result: unknown): string[] {
  if (!isObject(result)) return ['result must be an object'];
  const out: string[] = [];
  if (!(RUN_STATUSES as readonly unknown[]).includes(result.status)) out.push(`status ${JSON.stringify(result.status)} is not one of ${RUN_STATUSES.join(', ')}`);
  if (!isString(result.output)) out.push('output must be a string');
  if (result.status !== 'completed') {
    const reason = result.reason;
    if (!isObject(reason) || !nonEmpty(reason.code)) out.push(`a ${String(result.status)} result needs reason.code`);
  }
  if (result.reason !== undefined) {
    if (!isObject(result.reason)) out.push('reason must be an object');
    else if (result.reason.detail !== undefined && !isString(result.reason.detail)) out.push('reason.detail must be a string');
  }
  if (result.usage !== undefined) {
    const u = result.usage;
    if (!isObject(u) || !isCount(u.inputTokens) || !isCount(u.outputTokens)) out.push('usage must have non-negative inputTokens and outputTokens');
  }
  if (result.costUsd !== undefined && !isCount(result.costUsd)) out.push('costUsd must be a non-negative number');
  if (result.taskRef !== undefined && !nonEmpty(result.taskRef)) out.push('taskRef must be a non-empty string');
  out.push(...extProblems(result.ext));
  return out;
}

/** Problems of one `Attribution`, against the record it was made from. */
export function attributionProblems(a: unknown, record: readonly HopRecord[]): string[] {
  if (!isObject(a)) return ['attribution must be an object'];
  const out: string[] = [];
  if (!(isLayer(a.layer) || a.layer === 'host')) out.push(`layer ${JSON.stringify(a.layer)} is not a plexus layer id or host`);
  if (typeof a.confidence !== 'number' || !(a.confidence >= 0 && a.confidence <= 1)) out.push(`confidence ${String(a.confidence)} is not in [0, 1]`);
  if (!Array.isArray(a.evidence) || !a.evidence.every(isString)) out.push('evidence must be a list of strings');
  if (!nonEmpty(a.by)) out.push('by must name the adapter');
  if (a.member !== undefined && !record.some((h) => h.member === a.member)) out.push(`member "${String(a.member)}" is not in the record`);
  if (a.hopId !== undefined && !record.some((h) => h.hopId === a.hopId)) out.push(`hopId "${String(a.hopId)}" is not in the record`);
  if (a.memberLayer !== undefined && !isString(a.memberLayer)) out.push('memberLayer must be a string');
  return out;
}
