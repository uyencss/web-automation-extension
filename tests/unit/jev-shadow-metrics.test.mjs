// tests/unit/jev-shadow-metrics.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  percentile,
  canonicalJson,
  shadowEvidenceLine,
  aggregateShadowMetrics,
  aggregateFaultResults,
} from '../../lib/jev-shadow/metrics.mjs';

test('1. percentile: calculates nearest-rank percentile correctly', () => {
  const values100 = Array.from({ length: 100 }, (_, i) => i + 1);

  assert.equal(percentile(values100, 50), 50);
  assert.equal(percentile(values100, 95), 95);
  assert.equal(percentile([], 50), null);
  assert.equal(percentile(null, 50), null);
});

test('2. aggregateShadowMetrics: correctly computes statistics from shadow records', () => {
  const completeLineage = {
    provider: 'typesafe',
    model: 'jev-1.0',
    skillDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    questionSetDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    stateDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    requestDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };

  const incompleteLineage = {
    provider: 'typesafe',
    model: '', // empty
    skillDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };

  const records = [
    // Record 1: agree, ok, complete lineage, overhead 10ms, query 40ms, total 50ms
    {
      schema: 'webmcp-jev-shadow/1',
      status: 'ok',
      executed: false,
      browserActions: 0,
      agreement: true,
      jevDecision: {
        operation: 'CLICK',
        targetRef: 'r1',
        actionable: true,
        stale: false,
        invalid: false,
        reasons: [],
      },
      lineage: completeLineage,
      timing: { overheadMs: 10, queryMs: 40, totalMs: 50 },
      mcpCalls: { shadow: 0, browserActions: 0, normalAgent: 2 },
      questionCount: 3,
    },
    // Record 2: disagree, ok, complete lineage, overhead 20ms, query 60ms, total 80ms
    {
      schema: 'webmcp-jev-shadow/1',
      status: 'ok',
      executed: false,
      browserActions: 0,
      agreement: false,
      jevDecision: {
        operation: 'TYPE_TEXT',
        targetRef: 'r2',
        actionable: true,
        stale: false,
        invalid: false,
        reasons: [],
      },
      lineage: completeLineage,
      timing: { overheadMs: 20, queryMs: 60, totalMs: 80 },
      mcpCalls: { shadow: 0, browserActions: 0, normalAgent: 3 },
      questionCount: 3,
    },
    // Record 3: agreement null (control operation WAIT), ok, complete lineage, overhead 15ms, query 35ms, total 50ms
    {
      schema: 'webmcp-jev-shadow/1',
      status: 'ok',
      executed: false,
      browserActions: 0,
      agreement: null,
      jevDecision: {
        operation: 'WAIT',
        targetRef: null,
        actionable: true,
        stale: false,
        invalid: false,
        reasons: [],
      },
      lineage: completeLineage,
      timing: { overheadMs: 15, queryMs: 35, totalMs: 50 },
      mcpCalls: { shadow: 0, browserActions: 0, normalAgent: 1 },
      questionCount: 1,
    },
    // Record 4: stale case (DIGEST_MISMATCH), incomplete lineage, fallback-required
    {
      schema: 'webmcp-jev-shadow/1',
      status: 'fallback-required',
      executed: false,
      browserActions: 0,
      agreement: null,
      jevDecision: {
        operation: 'CLICK',
        targetRef: 'r1',
        actionable: false,
        stale: true,
        invalid: false,
        reasons: ['DIGEST_MISMATCH'],
      },
      lineage: incompleteLineage,
      timing: { overheadMs: 12, queryMs: 45, totalMs: 57 },
      mcpCalls: { shadow: 0, browserActions: 0, normalAgent: 2 },
      questionCount: 2,
    },
  ];

  const metrics = aggregateShadowMetrics(records, {
    provider: 'typesafe',
    corpusDigest: 'sha256:abc',
  });

  assert.equal(metrics.schema, 'webmcp-jev-shadow-metrics/1');
  assert.equal(metrics.decisions, 4);
  assert.equal(metrics.executed, 0);
  assert.equal(metrics.browserActions, 0);

  // Status
  assert.equal(metrics.status.ok, 3);
  assert.equal(metrics.status.invalid, 0);
  assert.equal(metrics.status.fallbackRequired, 1);

  // Agreement: 2 counted (records 1 and 2), 1 agree
  assert.equal(metrics.agreement.counted, 2);
  assert.equal(metrics.agreement.agree, 1);
  assert.equal(metrics.agreement.pct, 50);

  // Stale: 1 count out of 4 (25%), reason DIGEST_MISMATCH
  assert.equal(metrics.stale.count, 1);
  assert.equal(metrics.stale.pct, 25);
  assert.equal(metrics.stale.reasons.DIGEST_MISMATCH, 1);

  // Lineage: 3 complete out of 4 (75%)
  assert.equal(metrics.lineage.complete, 3);
  assert.equal(metrics.lineage.incomplete, 1);
  assert.equal(metrics.lineage.pct, 75);

  // Control and actionable
  assert.equal(metrics.controlDecisions, 1);
  assert.equal(metrics.actionableDecisions, 3);

  // Latency: overheads [10, 12, 15, 20]
  assert.equal(metrics.latencyMs.overhead.min, 10);
  assert.equal(metrics.latencyMs.overhead.max, 20);

  // MCP calls: shadow = 0, normalAgentTotal = 2 + 3 + 1 + 2 = 8
  assert.equal(metrics.mcpCalls.shadowTotal, 0);
  assert.equal(metrics.mcpCalls.normalAgentTotal, 8);
  assert.equal(metrics.mcpCalls.shadowPerDecision, 0);

  // Questions: total = 3 + 3 + 1 + 2 = 9, mean = 9/4 = 2.25
  assert.equal(metrics.questions.total, 9);
  assert.equal(metrics.questions.mean, 2.25);

  // Options pass-through
  assert.equal(metrics.provider, 'typesafe');
  assert.equal(metrics.corpusDigest, 'sha256:abc');
});

test('3. aggregateFaultResults: calculates detection percentage per fault and total', () => {
  const faults = ['replaced', 'hidden', 'disabled', 'covered', 'unbound'];
  const results = [];

  for (const fault of faults) {
    for (let i = 0; i < 3; i++) {
      results.push({
        fault,
        ok: false,
        stale: true,
        detected: fault,
      });
    }
  }

  const aggregated = aggregateFaultResults(results);
  assert.equal(aggregated.cases, 15);
  assert.equal(aggregated.staleDetected, 15);
  assert.equal(aggregated.detectionPct, 100);

  for (const fault of faults) {
    assert.equal(aggregated.byFault[fault].cases, 3);
    assert.equal(aggregated.byFault[fault].staleDetected, 3);
    assert.equal(aggregated.byFault[fault].pct, 100);
  }
});

test('4. shadowEvidenceLine: canonical and deterministic output', () => {
  const obj1 = { z: 1, a: 2, m: { b: 3, a: 4 } };
  const obj2 = { a: 2, m: { a: 4, b: 3 }, z: 1 };

  const line1 = shadowEvidenceLine(obj1);
  const line2 = shadowEvidenceLine(obj2);

  assert.equal(line1, line2);
  assert.ok(line1.endsWith('\n'));
  assert.equal(line1, '{"a":2,"m":{"a":4,"b":3},"z":1}\n');
});

test('5. aggregateShadowMetrics: status counts ok, invalid, fallbackRequired', () => {
  const validRecord = {
    schema: 'webmcp-jev-shadow/1',
    status: 'ok',
    executed: false,
    browserActions: 0,
    agreement: true,
    jevDecision: {
      operation: 'CLICK',
      targetRef: 'r1',
      actionable: true,
      stale: false,
      invalid: false,
      reasons: [],
    },
  };

  const invalidRecord = {
    schema: 'webmcp-jev-shadow/1',
    status: 'invalid',
    reason: 'INVALID_RESULT',
    executed: false,
    browserActions: 0,
    agreement: null,
    jevDecision: {
      operation: 'CLICK',
      targetRef: 'r1',
      actionable: false,
      stale: false,
      invalid: true,
      reasons: ['ANSWER_INVALID'],
    },
  };

  const metrics = aggregateShadowMetrics([validRecord, invalidRecord]);
  assert.equal(metrics.status.ok, 1);
  assert.equal(metrics.status.invalid, 1);
  assert.equal(metrics.status.fallbackRequired, 0);
});
