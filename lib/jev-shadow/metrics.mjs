// lib/jev-shadow/metrics.mjs
// M4 browser-step shadow metrics aggregator and evidence formatter.

import { CONTROL_OPERATIONS, canonicalJson } from './loop.mjs';

export { canonicalJson };

// Calculate nearest-rank percentile on an ascending sorted array.
// Returns null for empty arrays.
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const sorted = [...values].filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.max(0, Math.min(sorted.length - 1, rank - 1));
  return sorted[index];
}

// Format a single shadow execution record as a deterministic canonical JSON line.
export function shadowEvidenceLine(record) {
  return canonicalJson(record) + '\n';
}

const LINEAGE_FIELDS = Object.freeze([
  'provider',
  'model',
  'skillDigest',
  'questionSetDigest',
  'stateDigest',
  'requestDigest',
]);

function isLineageComplete(lineage) {
  if (!lineage || typeof lineage !== 'object') return false;
  return LINEAGE_FIELDS.every((f) => typeof lineage[f] === 'string' && lineage[f].trim().length > 0);
}

// Aggregate records from shadow browser-step runs into typed metrics envelope.
export function aggregateShadowMetrics(records, options = {}) {
  const list = Array.isArray(records) ? records : [];
  const decisions = list.length;
  let executed = 0;
  let browserActions = 0;
  let okCount = 0;
  let invalidStatusCount = 0;
  let fallbackRequiredCount = 0;

  let agreementCounted = 0;
  let agreementAgree = 0;

  let staleCount = 0;
  const staleReasons = {};

  let invalidCount = 0;
  const invalidReasons = {};

  let controlDecisions = 0;
  let actionableDecisions = 0;
  let completeLineage = 0;

  const overheads = [];
  const queries = [];
  const totals = [];
  let totalQuestions = 0;

  let shadowMcpTotal = 0;
  let normalAgentMcpTotal = 0;

  for (const r of list) {
    if (r.executed) executed++;
    if (typeof r.browserActions === 'number') browserActions += r.browserActions;

    if (r.status === 'ok') {
      okCount++;
    } else if (r.status === 'invalid') {
      invalidStatusCount++;
    } else if (r.status === 'fallback-required') {
      fallbackRequiredCount++;
    }

    if (typeof r.agreement === 'boolean') {
      agreementCounted++;
      if (r.agreement === true) agreementAgree++;
    }

    const jevDec = r.jevDecision;
    if (jevDec) {
      if (jevDec.stale === true) {
        staleCount++;
        for (const reason of jevDec.reasons || []) {
          if (reason === 'DIGEST_MISMATCH' || reason === 'TTL_EXPIRED') {
            staleReasons[reason] = (staleReasons[reason] || 0) + 1;
          }
        }
      }

      if (jevDec.invalid === true) {
        invalidCount++;
        for (const reason of jevDec.reasons || []) {
          if (
            reason === 'RESULT_INVALID' ||
            reason === 'ANSWER_INVALID' ||
            reason === 'TARGET_MISSING' ||
            reason === 'TARGET_INCOMPATIBLE' ||
            reason === 'TARGET_UNAVAILABLE'
          ) {
            invalidReasons[reason] = (invalidReasons[reason] || 0) + 1;
          }
        }
      }

      if (CONTROL_OPERATIONS.includes(jevDec.operation)) {
        controlDecisions++;
      }

      if (jevDec.actionable === true) {
        actionableDecisions++;
      }
    }

    if (isLineageComplete(r.lineage)) {
      completeLineage++;
    }

    if (r.timing) {
      if (typeof r.timing.overheadMs === 'number' && Number.isFinite(r.timing.overheadMs)) {
        overheads.push(r.timing.overheadMs);
      }
      if (typeof r.timing.queryMs === 'number' && Number.isFinite(r.timing.queryMs)) {
        queries.push(r.timing.queryMs);
      }
      if (typeof r.timing.totalMs === 'number' && Number.isFinite(r.timing.totalMs)) {
        totals.push(r.timing.totalMs);
      }
    }

    const qCount = r.questionCount ??
      (typeof r.questions === 'number' ? r.questions :
        (Array.isArray(r.questions) ? r.questions.length :
          (r.questions && typeof r.questions === 'object' ? Object.keys(r.questions).length : 0)));
    totalQuestions += qCount;

    shadowMcpTotal += r.mcpCalls?.shadow ?? 0;
    normalAgentMcpTotal += r.mcpCalls?.normalAgent ?? r.normalAgentCalls ?? r.normalAgentDecision?.mcpCalls ?? 0;
  }

  const agreementPct = agreementCounted > 0 ? (agreementAgree / agreementCounted) * 100 : null;
  const stalePct = decisions > 0 ? (staleCount / decisions) * 100 : null;
  const lineagePct = decisions > 0 ? (completeLineage / decisions) * 100 : null;
  const questionsMean = decisions > 0 ? totalQuestions / decisions : null;

  return {
    schema: 'webmcp-jev-shadow-metrics/1',
    decisions,
    executed,
    browserActions,
    status: {
      ok: okCount,
      invalid: invalidStatusCount,
      fallbackRequired: fallbackRequiredCount,
    },
    agreement: {
      counted: agreementCounted,
      agree: agreementAgree,
      pct: agreementPct,
    },
    stale: {
      count: staleCount,
      pct: stalePct,
      reasons: staleReasons,
    },
    invalid: {
      count: invalidCount,
      reasons: invalidReasons,
    },
    controlDecisions,
    actionableDecisions,
    lineage: {
      complete: completeLineage,
      incomplete: decisions - completeLineage,
      pct: lineagePct,
    },
    latencyMs: {
      overhead: {
        p50: percentile(overheads, 50),
        p95: percentile(overheads, 95),
        min: overheads.length > 0 ? Math.min(...overheads) : null,
        max: overheads.length > 0 ? Math.max(...overheads) : null,
      },
      query: {
        p50: percentile(queries, 50),
        p95: percentile(queries, 95),
      },
      total: {
        p50: percentile(totals, 50),
        p95: percentile(totals, 95),
      },
    },
    questions: {
      total: totalQuestions,
      mean: questionsMean,
    },
    mcpCalls: {
      shadowTotal: shadowMcpTotal,
      normalAgentTotal: normalAgentMcpTotal,
      shadowPerDecision: 0,
    },
    provider: options.provider ?? null,
    simulated: options.simulated ?? null,
    corpusDigest: options.corpusDigest ?? null,
    generatedAt: options.generatedAt ?? null,
  };
}

// Aggregate fault injection matrix results.
export function aggregateFaultResults(results) {
  const list = Array.isArray(results) ? results : [];
  const cases = list.length;
  const staleDetected = list.filter((r) => r.stale === true && r.detected === r.fault).length;
  const detectionPct = cases > 0 ? (staleDetected / cases) * 100 : 0;

  const byFault = {};
  for (const r of list) {
    const f = r.fault || 'unknown';
    if (!byFault[f]) {
      byFault[f] = { cases: 0, staleDetected: 0, pct: 0 };
    }
    byFault[f].cases++;
    if (r.stale === true && r.detected === r.fault) {
      byFault[f].staleDetected++;
    }
  }

  for (const f of Object.keys(byFault)) {
    const item = byFault[f];
    item.pct = item.cases > 0 ? (item.staleDetected / item.cases) * 100 : 0;
  }

  return {
    cases,
    staleDetected,
    detectionPct,
    byFault,
  };
}
