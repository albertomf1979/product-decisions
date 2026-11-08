'use strict';

// What the model must return, and the check every item passes before a file is written:
// each citation must be an event of this session's record (PRD LLM-5, goal G5).

const PHASES = ['discovery', 'definition', 'design', 'development', 'release', 'monitoring'];
const DECIDERS = ['user', 'llm', 'subagent'];
const EVENT_ID = '^[0-9A-HJKMNP-TV-Z]{26}$';
const ADR_ID = '^ADR-\\d{8}-[0-9a-f]{6}$';
const LIMITS = { title: 120, context: 2000, decision: 2000, consequences: 2000, alternative: 500, alternatives: 8, summary: 3000, evidence: 20 };

const text = (maxLength) => ({ type: 'string', maxLength });
const ids = (pattern, minItems = 0) => ({ type: 'array', items: { type: 'string', pattern }, minItems, maxItems: LIMITS.evidence });

const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['decisions', 'phase_notes'],
  properties: {
    decisions: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'decided_by', 'context', 'decision', 'alternatives', 'consequences', 'evidence', 'related', 'supersedes'],
        properties: {
          title: text(LIMITS.title),
          decided_by: { type: 'string', enum: DECIDERS },
          context: text(LIMITS.context),
          decision: text(LIMITS.decision),
          alternatives: { type: 'array', items: text(LIMITS.alternative), maxItems: LIMITS.alternatives },
          consequences: text(LIMITS.consequences),
          evidence: ids(EVENT_ID, 1),
          related: ids(ADR_ID),
          supersedes: ids(ADR_ID),
        },
      },
    },
    phase_notes: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['phase', 'title', 'summary', 'evidence'],
        properties: { phase: { type: 'string', enum: PHASES }, title: text(LIMITS.title), summary: text(LIMITS.summary), evidence: ids(EVENT_ID, 1) },
      },
    },
  },
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v) => (Array.isArray(v) ? v : []);
const unique = (values) => [...new Set(values)];

/** @returns {{ evidence: string[] } | { reason: string }} */
function checkEvidence(item, byId) {
  const evidence = unique(list(item.evidence).filter((id) => typeof id === 'string')).slice(0, LIMITS.evidence);
  if (evidence.length === 0) return { reason: 'no_evidence' };
  if (evidence.some((id) => !byId.has(id))) return { reason: 'unknown_evidence' };
  return { evidence };
}

/**
 * Keeps the items whose every citation exists in `events` (the whole session record).
 * The model's word on who decided counts only if an evidence event shows that actor,
 * and the name comes from the record.
 *
 * @returns {{ decisions: object[], notes: object[], rejected: Array<{ kind: 'decision' | 'note', reason: string }> }}
 */
function checkOutput(output, { events, existingIds }) {
  const byId = new Map(events.map((e) => [e.event_id, e]));
  const result = { decisions: [], notes: [], rejected: [] };
  if (!isObject(output)) return result;
  const reject = (kind, reason) => result.rejected.push({ kind, reason });

  for (const item of list(output.decisions)) {
    if (!isObject(item) || !str(item.title, LIMITS.title)) {
      reject('decision', 'shape');
      continue;
    }
    const checked = checkEvidence(item, byId);
    if (checked.reason) {
      reject('decision', checked.reason);
      continue;
    }
    const actors = checked.evidence.map((id) => byId.get(id)).filter((e) => e.actor && e.actor.type === item.decided_by)
      .sort((a, b) => (a.event_id < b.event_id ? -1 : 1));
    if (!DECIDERS.includes(item.decided_by) || actors.length === 0) {
      reject('decision', 'attribution');
      continue;
    }
    const known = (values) => unique(list(values).filter((id) => typeof id === 'string' && existingIds.has(id)));
    result.decisions.push({
      title: str(item.title, LIMITS.title),
      decided_by: { type: item.decided_by, name: String(actors[0].actor.name || '') },
      context: str(item.context, LIMITS.context),
      decision: str(item.decision, LIMITS.decision),
      alternatives: list(item.alternatives).map((a) => str(a, LIMITS.alternative)).filter(Boolean).slice(0, LIMITS.alternatives),
      consequences: str(item.consequences, LIMITS.consequences),
      evidence: checked.evidence,
      related: known(item.related),
      supersedes: known(item.supersedes),
    });
  }

  for (const item of list(output.phase_notes)) {
    if (!isObject(item) || !str(item.title, LIMITS.title)) {
      reject('note', 'shape');
      continue;
    }
    if (!PHASES.includes(item.phase)) {
      reject('note', 'phase');
      continue;
    }
    const checked = checkEvidence(item, byId);
    if (checked.reason) {
      reject('note', checked.reason);
      continue;
    }
    result.notes.push({ phase: item.phase, title: str(item.title, LIMITS.title), summary: str(item.summary, LIMITS.summary), evidence: checked.evidence });
  }
  return result;
}

module.exports = { OUTPUT_SCHEMA, PHASES, checkOutput };
