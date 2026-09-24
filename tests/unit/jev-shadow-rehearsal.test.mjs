// tests/unit/jev-shadow-rehearsal.test.mjs
// Unit tests for milestone M4 rehearsal harness.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  mulberry32,
  buildCorpus,
  rehearsalProvider,
  runRehearsal,
  applyFault,
  buildNormalizedProbabilities,
} from '../../scripts/jev-shadow-rehearsal.mjs';
import {
  canonicalJson,
  sha256hex,
  normalizeAriaSnapshot,
  recheckShadowTarget,
} from '../../lib/jev-shadow/loop.mjs';

test('1. corpus: generator is deterministic, unique, valid syntax, and covers variants', () => {
  const corpus1 = buildCorpus({ count: 216 });
  const corpus2 = buildCorpus({ count: 216 });

  assert.ok(corpus1.length >= 216, `Expected >= 216 cases, got ${corpus1.length}`);

  const ids = corpus1.map((c) => c.caseId);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, corpus1.length, 'Every caseId must be unique');

  assert.equal(canonicalJson(corpus1), canonicalJson(corpus2), 'Corpus must be deterministic (same bytes)');

  let disabledVariantsCount = 0;
  let replacedVariantsCount = 0;
  let hiddenVariantsCount = 0;

  for (const c of corpus1) {
    assert.match(c.urlOrigin, /^https?:\/\/[a-zA-Z0-9.-]+(:[0-9]+)?$/, `Invalid urlOrigin format: ${c.urlOrigin}`);
    assert.equal(c.urlOrigin.includes('?'), false, 'urlOrigin must not contain query parameters');
    assert.equal(c.urlOrigin.includes('#'), false, 'urlOrigin must not contain hash fragments');

    const norm = normalizeAriaSnapshot(c.snapshot, { includeDisabled: true });
    assert.ok(norm.elements.length >= 1, `Snapshot for case ${c.caseId} must parse to at least 1 element with operations`);

    if (c.snapshot.includes('[disabled]')) {
      disabledVariantsCount++;
    }

    if (c.normalAgentDecision?.targetRef) {
      const replacedSnap = applyFault(c.snapshot, c.normalAgentDecision.targetRef, 'replaced');
      if (replacedSnap !== c.snapshot) replacedVariantsCount++;

      const hiddenSnap = applyFault(c.snapshot, c.normalAgentDecision.targetRef, 'hidden');
      if (hiddenSnap !== c.snapshot) hiddenVariantsCount++;
    }
  }

  assert.ok(disabledVariantsCount > 0, `Expected disabled variants count > 0, got ${disabledVariantsCount}`);
  assert.ok(replacedVariantsCount > 0, `Expected replaced variants count > 0, got ${replacedVariantsCount}`);
  assert.ok(hiddenVariantsCount > 0, `Expected hidden variants count > 0, got ${hiddenVariantsCount}`);
});

test('2. provider: deterministic answers, satisfies §6.5 rules, and deliberate disagreement exists', () => {
  const wireBody = {
    state: {
      goal: 'Submit order now',
      elements: [
        { ref: 'r1', role: 'button', name: 'Submit order', value: '', operations: ['CLICK'], enabled: true },
        { ref: 'r2', role: 'button', name: 'Submit order now', value: '', operations: ['CLICK'], enabled: true },
      ],
      recentActions: [],
      urlOrigin: 'https://app.example.com',
      snapshotDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    },
    model: 'jev-1.13.0',
    questions: {
      operation: {
        type: 'choice',
        instructions: { goal: 'Submit order now', question: 'Choose operation' },
        criteria: { CLICK: null, WAIT: 'wait', DONE: 'done', BLOCKED: 'blocked' },
      },
      click_target: {
        type: 'choice',
        instructions: { goal: 'Submit order now', assumedOperation: 'CLICK', question: 'Choose target' },
        criteria: { r1: { role: 'button', name: 'Submit order' }, r2: { role: 'button', name: 'Submit order now' } },
      },
    },
  };

  const res1 = rehearsalProvider(wireBody, { caseIndex: 1 });
  const res2 = rehearsalProvider(wireBody, { caseIndex: 1 });
  assert.deepEqual(res1.answers, res2.answers, 'Identical wire body must yield deep equal answers');
  assert.ok(typeof res1.usage.input_tokens === 'number' && res1.usage.input_tokens >= 0);
  assert.ok(typeof res1.usage.output_tokens === 'number' && res1.usage.output_tokens >= 0);

  // Validate every answer strictly per §6.5 rules
  for (const [qId, ans] of Object.entries(res1.answers)) {
    const qDef = wireBody.questions[qId];
    const criteriaKeys = Object.keys(qDef.criteria);

    assert.equal(ans.type, 'choice');
    assert.ok(criteriaKeys.includes(ans.choice), `choice ${ans.choice} must be in criteria`);

    const probKeys = Object.keys(ans.probabilities);
    assert.equal(probKeys.length, criteriaKeys.length, 'probabilities must cover all criteria keys');
    for (const k of criteriaKeys) {
      assert.ok(probKeys.includes(k), `probabilities must contain key ${k}`);
      const v = ans.probabilities[k];
      assert.ok(typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1, `prob ${v} out of bounds`);
    }

    const sum = Object.values(ans.probabilities).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) <= 0.02, `prob sum ${sum} must be within 0.02 of 1.0`);

    const maxVal = Math.max(...Object.values(ans.probabilities));
    assert.ok(ans.probabilities[ans.choice] >= maxVal - 1e-6, `choice ${ans.choice} prob must equal maximum`);

    assert.ok(typeof ans.confidence === 'number' && ans.confidence >= 0 && ans.confidence <= 1, 'confidence in [0, 1]');
  }

  // Deliberate disagreement: caseIndex % 11 === 0 picks top-2 whereas next caseIndex picks top-1
  const ansDisagree = rehearsalProvider(wireBody, { caseIndex: 0 }); // 0 % 11 === 0 -> top-2
  const ansAgree = rehearsalProvider(wireBody, { caseIndex: 1 }); // 1 % 11 !== 0 -> top-1

  assert.notEqual(
    ansDisagree.answers.click_target.choice,
    ansAgree.answers.click_target.choice,
    'Deliberate disagreement zone must pick alternate target when caseIndex % 11 === 0'
  );
  assert.equal(ansDisagree.answers.click_target.choice, 'r1');
  assert.equal(ansAgree.answers.click_target.choice, 'r2');
});

test('3. runRehearsal nhỏ (count: 24, standalone query): metrics, lineage, faults, and leakage', async () => {
  const result = await runRehearsal({ count: 24, faultsPerType: 10 });
  const metrics = result.metrics;

  assert.ok(metrics.decisions >= 24, `Expected >= 24 decisions, got ${metrics.decisions}`);
  assert.equal(metrics.executed, 0);
  assert.equal(metrics.browserActions, 0);
  assert.equal(metrics.mcpCalls.shadowTotal, 0);
  assert.equal(metrics.lineage.pct, 100);
  assert.equal(metrics.status.fallbackRequired, 0);

  // Fault detection 100%
  assert.ok(metrics.faults.cases > 0);
  assert.equal(metrics.faults.detectionPct, 100);
  for (const [faultType, data] of Object.entries(metrics.faults.byFault)) {
    assert.equal(data.pct, 100, `Fault type ${faultType} must have 100% detection rate`);
  }

  // Leakage hits 0
  assert.equal(metrics.leakage.hits, 0);
  assert.equal(metrics.leakage.offenders.length, 0);
  assert.ok(metrics.leakage.scanned > 0, `Expected scanned secrets > 0, got ${metrics.leakage.scanned}`);

  // Corpus digest matches recomputed digest
  const expectedCases = buildCorpus({ count: 24 });
  const expectedDigest = 'sha256:' + sha256hex(canonicalJson(expectedCases));
  assert.equal(metrics.corpusDigest, expectedDigest);
});

test('4. applyFault: 4 faults mutate snapshots correctly and recheck reports stale + correct fault', () => {
  const snapshot = [
    '- document "Settings Form"',
    '- ref=r1 button "Confirm"',
    '- ref=r2 button "Cancel"',
  ].join('\n');

  const ref = 'r1';
  const now = 1000000;
  const decision = {
    operation: 'CLICK',
    targetRef: ref,
    confidence: 0.85,
    snapshotDigest: 'sha256:000',
    decidedAt: now,
    fingerprint: 'sha256:' + sha256hex(`button\0Confirm\0\0CLICK`),
  };

  // 1. replaced: changes name, adds (replaced)
  const replacedSnap = applyFault(snapshot, ref, 'replaced');
  assert.notEqual(replacedSnap, snapshot);
  assert.ok(replacedSnap.includes('"Confirm (replaced)"'));
  const checkReplaced = recheckShadowTarget({ decision, freshSnapshot: replacedSnap, now, ttlMs: 30000 });
  assert.equal(checkReplaced.stale, true);
  assert.equal(checkReplaced.fault, 'replaced');

  // 2. hidden: deletes line containing ref
  const hiddenSnap = applyFault(snapshot, ref, 'hidden');
  assert.notEqual(hiddenSnap, snapshot);
  assert.ok(!hiddenSnap.includes('ref=r1'));
  const checkHidden = recheckShadowTarget({ decision, freshSnapshot: hiddenSnap, now, ttlMs: 30000 });
  assert.equal(checkHidden.stale, true);
  assert.equal(checkHidden.fault, 'hidden');

  // 3. disabled: adds [disabled]
  const disabledSnap = applyFault(snapshot, ref, 'disabled');
  assert.notEqual(disabledSnap, snapshot);
  assert.ok(disabledSnap.includes('ref=r1 button "Confirm" [disabled]'));
  const checkDisabled = recheckShadowTarget({ decision, freshSnapshot: disabledSnap, now, ttlMs: 30000 });
  assert.equal(checkDisabled.stale, true);
  assert.equal(checkDisabled.fault, 'disabled');

  // 4. covered: snapshot unchanged, coveredRefs triggers covered fault
  const coveredSnap = applyFault(snapshot, ref, 'covered');
  assert.equal(coveredSnap, snapshot);
  const checkCovered = recheckShadowTarget({ decision, freshSnapshot: coveredSnap, coveredRefs: [ref], now, ttlMs: 30000 });
  assert.equal(checkCovered.stale, true);
  assert.equal(checkCovered.fault, 'covered');
});

test('5. zero-action invariant: runRehearsal never invokes browser gateway and marks 0 actions', async () => {
  const { records, metrics } = await runRehearsal({ count: 12, faultsPerType: 2 });

  assert.equal(metrics.browserActions, 0);
  assert.equal(metrics.executed, 0);
  assert.ok(records.length >= 12);
  for (const r of records) {
    assert.equal(r.executed, false);
    assert.equal(r.browserActions, 0);
    assert.equal(r.shadow, true);
    assert.equal(r.mcpCalls.shadow, 0);
  }
});

test('6. clientModule wiring: offline fixture proves m2-client wiring, 0 fallback, lineage 100%, and wire capture', async () => {
  const tmpDir = os.tmpdir();
  const fixturePath = path.join(tmpDir, `fixture-jev-client-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  const fixtureCode = `export function createJevClient({ transport, model }) {
  return {
    async query(request) {
      const res = await transport({ request: { state: request.state, model, questions: request.questions } });
      const body = res.body;
      return {
        result: {
          schema: 'webmcp-jev-result/1',
          requestId: request.requestId,
          status: 'ok',
          advisoryOnly: true,
          answers: body.answers,
          lineage: {
            provider: 'typesafe',
            model,
            skillDigest: 'sha256:' + '0'.repeat(64),
            questionSetDigest: request.questionSet.digest,
            stateDigest: 'sha256:' + '1'.repeat(64),
            requestDigest: 'sha256:' + '2'.repeat(64),
          },
          timing: { latencyMs: 1, attempts: 1 },
          usage: body.usage,
        },
      };
    },
  };
}
`;

  fs.writeFileSync(fixturePath, fixtureCode, 'utf8');

  try {
    const { metrics, wireBodies } = await runRehearsal({ count: 24, clientModule: fixturePath });

    assert.equal(metrics.clientSource, 'm2-client');
    assert.equal(metrics.status.fallbackRequired, 0);
    assert.ok(metrics.status.ok >= 24, `Expected status.ok >= 24, got ${metrics.status.ok}`);
    assert.equal(metrics.lineage.pct, 100);
    assert.equal(metrics.browserActions, 0);
    assert.equal(metrics.leakage.hits, 0);
    assert.ok(wireBodies.length >= 24, `Expected wireBodies.length >= 24, got ${wireBodies.length}`);

    for (const wb of wireBodies) {
      const body = wb.wireBody ?? wb;
      assert.ok(body.state, 'wire body must have state');
      assert.ok(body.questions, 'wire body must have questions');
      assert.ok(body.model, 'wire body must have model');
    }
  } finally {
    try {
      fs.unlinkSync(fixturePath);
    } catch {
      // ignore cleanup errors
    }
  }
});

test('7. buildNormalizedProbabilities: 81 keys and 2 keys maintain finite bounds [0, 1], sum ≈ 1, choice = max', () => {
  // Test 81 keys
  const keys81 = Array.from({ length: 81 }, (_, i) => `k${i}`);
  const probs81 = buildNormalizedProbabilities(keys81, 'k0', 0.75, { k1: 5.0, k2: 2.0 });
  const vals81 = Object.values(probs81);
  assert.equal(vals81.length, 81);
  for (const v of vals81) {
    assert.equal(typeof v, 'number');
    assert.equal(Number.isFinite(v), true);
    assert.ok(v >= 0, `Value ${v} must be >= 0`);
    assert.ok(v <= 1, `Value ${v} must be <= 1`);
  }
  const sum81 = vals81.reduce((a, b) => a + b, 0);
  assert.ok(sum81 >= 0.98 && sum81 <= 1.02, `Sum ${sum81} must be within [0.98, 1.02]`);
  assert.ok(Math.abs(sum81 - 1.0) < 1e-6, `Sum ${sum81} must be ≈ 1.0`);
  const max81 = Math.max(...vals81);
  assert.ok(Math.abs(probs81.k0 - max81) < 1e-6, `Choice k0 (${probs81.k0}) must be max (${max81})`);

  // Test 2 keys
  const keys2 = ['keyA', 'keyB'];
  const probs2 = buildNormalizedProbabilities(keys2, 'keyA', 0.65);
  const vals2 = Object.values(probs2);
  assert.equal(vals2.length, 2);
  for (const v of vals2) {
    assert.equal(typeof v, 'number');
    assert.equal(Number.isFinite(v), true);
    assert.ok(v >= 0, `Value ${v} must be >= 0`);
    assert.ok(v <= 1, `Value ${v} must be <= 1`);
  }
  const sum2 = vals2.reduce((a, b) => a + b, 0);
  assert.ok(sum2 >= 0.98 && sum2 <= 1.02, `Sum ${sum2} must be within [0.98, 1.02]`);
  assert.ok(Math.abs(sum2 - 1.0) < 1e-6, `Sum ${sum2} must be ≈ 1.0`);
  const max2 = Math.max(...vals2);
  assert.ok(Math.abs(probs2.keyA - max2) < 1e-6, `Choice keyA (${probs2.keyA}) must be max (${max2})`);
});

test('8. runRehearsal full (count: 216, standalone): fallbackRequired 0, lineage 100%, decisions >= 200, zero actions, zero leakage', async () => {
  const result = await runRehearsal({ count: 216, faultsPerType: 10 });
  const metrics = result.metrics;

  assert.equal(metrics.status.fallbackRequired, 0);
  assert.equal(metrics.lineage.pct, 100);
  assert.ok(metrics.decisions >= 200, `Expected decisions >= 200, got ${metrics.decisions}`);
  assert.equal(metrics.browserActions, 0);
  assert.equal(metrics.leakage.hits, 0);
});


