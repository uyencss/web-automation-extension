// tests/unit/jev-shadow-loop.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  parseAriaSnapshot,
  normalizeAriaSnapshot,
  buildBrowserStepRequest,
  validateShadowDecision,
  recheckShadowTarget,
  runShadowBrowserStep,
  deriveUrlOrigin,
  canonicalJson,
  sha256hex,
  SHADOW_RECORD_SCHEMA,
  GOAL_SECRET_PATTERNS,
  goalCarriesSecret,
  scrubEvidenceText,
  projectNormalAgentDecision,
  projectPostcondition,
  ENGINE_VALUES,
  OPERATION_VALUES,
  METHOD_VALUES,
  REF_PATTERN,
  CLOSED_REF_PATTERN,
  isClosedRef,
  LINEAGE_PROVIDER,
  FAILURE_CODES,
  RESULT_REASONS,
  projectLineage,
  sanitizeReasonCode,
  sanitizeResultReason,
  closedConfidence,
  isoOrNull,
  REQUEST_ID_PATTERN,
  closedRequestId,
} from '../../lib/jev-shadow/loop.mjs';
import { shadowEvidenceLine } from '../../lib/jev-shadow/metrics.mjs';

test('1. parse/normalize: parses sample snapshot and applies normalizations', () => {
  const sample = [
    '- document "Page title"',
    '- ref=r3 heading "Settings" (h1)',
    '- ref=r5 button "Sign in"',
    '  - ref=r6 textbox "Email" value="a@b.co"',
    '  - ref=r7 textbox "Password" value="[value redacted]"',
    '  - ref=r8 button "Show password" [disabled]',
    '  - ref=f1r2 link "Đăng nhập"',
    '  - ref=r9 checkbox "Remember me" [checked=true]',
    '  - ref=r10 combobox "Country" value="Vietnam"',
    '  - text "..."',
    '  - option "Vietnam" value="VN" [selected]',
    '  - note "3 more options truncated"',
  ].join('\n');

  const { entries, stats: parseStats } = parseAriaSnapshot(sample);
  assert.equal(parseStats.documents, 1);
  assert.equal(parseStats.elements, 8);
  assert.equal(parseStats.texts, 1);
  assert.equal(parseStats.options, 1);
  assert.equal(parseStats.notes, 1);
  assert.equal(parseStats.noteTruncated, 1);
  assert.equal(parseStats.malformed, 0);

  const norm = normalizeAriaSnapshot(sample);
  assert.equal(norm.stats.noteTruncated, 1);
  assert.equal(norm.coverageUncertain, true);
  const elements = norm.elements;

  // Disabled element r8 must be omitted by default
  assert.equal(elements.some((el) => el.ref === 'r8'), false);
  assert.equal(norm.stats.droppedDisabled, 1);

  // heading r3 has no operations so it is dropped, but its name was pushed to ancestor stack
  assert.equal(elements.some((el) => el.ref === 'r3'), false);
  assert.equal(norm.stats.droppedNoOps, 1);

  // Verify r5 button
  const r5 = elements.find((el) => el.ref === 'r5');
  assert.ok(r5);
  assert.equal(r5.role, 'button');
  assert.deepEqual(r5.operations, ['CLICK']);

  // Verify r6 textbox
  const r6 = elements.find((el) => el.ref === 'r6');
  assert.ok(r6);
  assert.equal(r6.role, 'textbox');
  assert.equal(r6.value, 'a@b.co');
  assert.deepEqual(r6.operations, ['TYPE_TEXT']);
  // Indented inside r5 button and r3 heading
  assert.ok(r6.parentContext.includes('Sign in') || r6.parentContext.includes('Settings'));

  // Verify r7 textbox with value="[value redacted]" -> redacted to ''
  const r7 = elements.find((el) => el.ref === 'r7');
  assert.ok(r7);
  assert.equal(r7.value, '');

  // Verify real password value redaction
  const pwSnapshot = '- ref=r99 textbox "User Password" value="supersecret123"';
  const normPw = normalizeAriaSnapshot(pwSnapshot);
  const r99 = normPw.elements.find((el) => el.ref === 'r99');
  assert.ok(r99);
  assert.equal(r99.value, '');
  assert.equal(normPw.stats.redactedValues, 1);

  // Verify f1r2 link
  const f1r2 = elements.find((el) => el.ref === 'f1r2');
  assert.ok(f1r2);
  assert.equal(f1r2.role, 'link');
  assert.deepEqual(f1r2.operations, ['CLICK']);

  // Verify r9 checkbox
  const r9 = elements.find((el) => el.ref === 'r9');
  assert.ok(r9);
  assert.equal(r9.role, 'checkbox');
  assert.equal(r9.checked, true);
  assert.deepEqual(r9.operations, ['CLICK']);

  // Verify r10 combobox
  const r10 = elements.find((el) => el.ref === 'r10');
  assert.ok(r10);
  assert.equal(r10.role, 'combobox');
  assert.equal(r10.value, 'Vietnam');
  assert.deepEqual(r10.operations, ['SELECT']);

  // Digest stability
  const normAgain = normalizeAriaSnapshot(sample);
  assert.equal(norm.snapshotDigest, normAgain.snapshotDigest);

  const diffNorm = normalizeAriaSnapshot('- ref=r1 button "Different"');
  assert.notEqual(norm.snapshotDigest, diffNorm.snapshotDigest);
});

test('2. cap: elements cap and bytes cap trigger coverageUncertain', () => {
  // Generate 120 buttons
  const lines = [];
  for (let i = 1; i <= 120; i++) {
    lines.push(`- ref=r${i} button "Button ${i}"`);
  }
  const bigSnapshot = lines.join('\n');

  const norm = normalizeAriaSnapshot(bigSnapshot, { maxElements: 80 });
  assert.equal(norm.elements.length, 80);
  assert.equal(norm.coverageUncertain, true);
  assert.equal(norm.stats.truncated, true);

  // Test byte cap
  const byteNorm = normalizeAriaSnapshot(bigSnapshot, { maxElements: 80, maxStateBytes: 500 });
  assert.ok(byteNorm.elements.length < 80);
  assert.equal(byteNorm.coverageUncertain, true);
  assert.equal(byteNorm.stats.bytesTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(byteNorm.elements)) <= 500);
});

test('3. fan-out one request: builds questions and valid canonical digest', () => {
  const snapshot = [
    '- ref=r1 button "Submit"',
    '- ref=r2 textbox "Username"',
    '- ref=r3 combobox "Role"',
  ].join('\n');

  const built = buildBrowserStepRequest({
    snapshot,
    goal: 'Log into application',
    requestId: 'req-001@session',
    url: 'https://app.example.com/login?step=1',
    runId: 'run-abc',
  });

  const { request, questions } = built;
  assert.equal(request.schema, 'webmcp-jev-request/1');
  assert.equal(request.kind, 'browser-step');
  assert.equal(request.state.urlOrigin, 'https://app.example.com');

  // Verify operation criteria
  const opCriteria = request.questions.operation.criteria;
  assert.ok('CLICK' in opCriteria);
  assert.ok('TYPE_TEXT' in opCriteria);
  assert.ok('SELECT' in opCriteria);
  assert.ok('WAIT' in opCriteria);
  assert.ok('DONE' in opCriteria);
  assert.ok('BLOCKED' in opCriteria);

  // Verify target questions
  assert.ok('click_target' in request.questions);
  assert.ok('type_text_target' in request.questions);
  assert.ok('select_target' in request.questions);

  assert.deepEqual(Object.keys(request.questions.click_target.criteria), ['r1']);
  assert.deepEqual(Object.keys(request.questions.type_text_target.criteria), ['r2']);
  assert.deepEqual(Object.keys(request.questions.select_target.criteria), ['r3']);
  assert.equal('none' in request.questions.click_target.criteria, false);
  assert.equal('NONE' in request.questions.click_target.criteria, false);
  assert.equal('none' in built.targetFingerprints, false);
  assert.equal('NONE' in built.targetFingerprints, false);

  // Recalculate questionSet digest independently
  const expectedDigest = 'sha256:' + createHash('sha256').update(canonicalJson(request.questions)).digest('hex');
  assert.equal(request.questionSet.digest, expectedDigest);

  // Round-trip test
  const roundTripped = JSON.parse(JSON.stringify(request));
  const roundTrippedDigest = 'sha256:' + createHash('sha256').update(canonicalJson(roundTripped.questions)).digest('hex');
  assert.equal(roundTrippedDigest, expectedDigest);
});

test('4. canonical/deriveUrlOrigin: sanitizes URL and rejects malformed inputs', () => {
  const origin = deriveUrlOrigin('https://a.b/path?token=SECRET#x');
  assert.equal(origin, 'https://a.b');

  const httpOrigin = deriveUrlOrigin('http://localhost:8080/dashboard');
  assert.equal(httpOrigin, 'http://localhost:8080');

  assert.throws(() => deriveUrlOrigin('ftp://evil.com'), /SNAPSHOT_INVALID/);
  assert.throws(() => deriveUrlOrigin('javascript:alert(1)'), /SNAPSHOT_INVALID/);
  assert.throws(() => deriveUrlOrigin('not a url'), /SNAPSHOT_INVALID/);
  assert.throws(() => deriveUrlOrigin(''), /SNAPSHOT_INVALID/);
});

test('5. validate: checks result envelope, options, probability sums, and target binding', () => {
  const snapshot = '- ref=r5 button "Submit"\n- ref=r6 textbox "Email"';
  const built = buildBrowserStepRequest({
    snapshot,
    goal: 'Submit form',
    requestId: 'req-100',
    urlOrigin: 'https://example.com',
    runId: 'run-1',
  });

  const validResult = {
    schema: 'webmcp-jev-result/1',
    requestId: 'req-100',
    status: 'ok',
    advisoryOnly: true,
    answers: {
      operation: {
        type: 'choice',
        choice: 'CLICK',
        probabilities: { CLICK: 0.9, TYPE_TEXT: 0.05, WAIT: 0.02, DONE: 0.02, BLOCKED: 0.01 },
        confidence: 0.95,
      },
      click_target: {
        type: 'choice',
        choice: 'r5',
        probabilities: { r5: 1.0 },
        confidence: 0.98,
      },
      type_text_target: {
        type: 'choice',
        choice: 'r6',
        probabilities: { r6: 1.0 },
        confidence: 0.9,
      },
    },
    lineage: {
      provider: 'typesafe',
      model: 'jev-1.0',
      skillDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      questionSetDigest: built.request.questionSet.digest,
      stateDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      requestDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
    timing: { latencyMs: 50, attempts: 1 },
    usage: { inputTokens: 100, outputTokens: 20 },
  };

  // (a) Valid result
  const v1 = validateShadowDecision(validResult, {
    request: built.request,
    elements: built.elements,
    snapshotDigest: built.snapshotDigest,
  });
  assert.equal(v1.ok, true);
  assert.equal(v1.actionable, true);
  assert.equal(v1.decision.operation, 'CLICK');
  assert.equal(v1.decision.targetRef, 'r5');

  // (b) Unknown ref -> TARGET_MISSING, invalid: true, stale: false
  const resBadRef = JSON.parse(JSON.stringify(validResult));
  resBadRef.answers.click_target.choice = 'r999';
  resBadRef.answers.click_target.probabilities = { r999: 1.0 };
  const v2 = validateShadowDecision(resBadRef, {
    request: built.request,
    elements: built.elements,
    snapshotDigest: built.snapshotDigest,
  });
  assert.equal(v2.ok, false);
  assert.equal(v2.invalid, true);
  assert.equal(v2.stale, false);
  assert.ok(v2.reasons.includes('TARGET_MISSING'));

  // (c) Incompatible target: TYPE_TEXT pointing to button r5
  const resIncompat = JSON.parse(JSON.stringify(validResult));
  resIncompat.answers.operation.choice = 'TYPE_TEXT';
  resIncompat.answers.type_text_target.choice = 'r5';
  resIncompat.answers.type_text_target.probabilities = { r5: 1.0 };
  const v3 = validateShadowDecision(resIncompat, {
    request: built.request,
    elements: built.elements,
    snapshotDigest: built.snapshotDigest,
  });
  assert.equal(v3.ok, false);
  assert.equal(v3.invalid, true);
  assert.ok(v3.reasons.includes('TARGET_INCOMPATIBLE'));

  // (d) Operation choice not in criteria -> ANSWER_INVALID
  const resBadOp = JSON.parse(JSON.stringify(validResult));
  resBadOp.answers.operation.choice = 'INVALID_OP';
  const v4 = validateShadowDecision(resBadOp, {
    request: built.request,
    elements: built.elements,
    snapshotDigest: built.snapshotDigest,
  });
  assert.equal(v4.ok, false);
  assert.equal(v4.invalid, true);
  assert.ok(v4.reasons.includes('ANSWER_INVALID'));

  // (e) Probabilities sum deviates > 0.02 -> ANSWER_INVALID
  const resBadSum = JSON.parse(JSON.stringify(validResult));
  resBadSum.answers.operation.probabilities = { CLICK: 0.5, TYPE_TEXT: 0.1, WAIT: 0.1, DONE: 0.1, BLOCKED: 0.1 }; // sum = 0.9
  const v5 = validateShadowDecision(resBadSum, {
    request: built.request,
    elements: built.elements,
    snapshotDigest: built.snapshotDigest,
  });
  assert.equal(v5.ok, false);
  assert.equal(v5.invalid, true);
  assert.ok(v5.reasons.includes('ANSWER_INVALID'));

  // (f) Choice does not have max probability -> ANSWER_INVALID
  const resNotMax = JSON.parse(JSON.stringify(validResult));
  resNotMax.answers.operation.choice = 'CLICK';
  resNotMax.answers.operation.probabilities = { CLICK: 0.4, TYPE_TEXT: 0.5, WAIT: 0.05, DONE: 0.03, BLOCKED: 0.02 };
  const v6 = validateShadowDecision(resNotMax, {
    request: built.request,
    elements: built.elements,
    snapshotDigest: built.snapshotDigest,
  });
  assert.equal(v6.ok, false);
  assert.equal(v6.invalid, true);
  assert.ok(v6.reasons.includes('ANSWER_INVALID'));

  // (g) snapshotDigest mismatch -> stale: true, DIGEST_MISMATCH
  const v7 = validateShadowDecision(validResult, {
    request: built.request,
    elements: built.elements,
    snapshotDigest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  });
  assert.equal(v7.stale, true);
  assert.ok(v7.reasons.includes('DIGEST_MISMATCH'));

  // (h) boundAt older than ttl -> TTL_EXPIRED, stale: true
  const v8 = validateShadowDecision(validResult, {
    request: built.request,
    elements: built.elements,
    snapshotDigest: built.snapshotDigest,
    now: 100000,
    boundAt: 50000,
    ttlMs: 30000,
  });
  assert.equal(v8.stale, true);
  assert.ok(v8.reasons.includes('TTL_EXPIRED'));
  assert.equal(v8.decision.decidedAt, 50000);

  // (i) none target -> ok: true, actionable: false
  const builtUncertain = buildBrowserStepRequest({
    snapshot,
    goal: 'Submit form',
    requestId: 'req-101',
    urlOrigin: 'https://example.com',
    runId: 'run-1',
    maxElements: 1, // forces coverageUncertain = true, offering none in target criteria
  });
  assert.equal(builtUncertain.coverageUncertain, true);
  assert.equal('none' in builtUncertain.request.questions.click_target.criteria, true);
  assert.equal('NONE' in builtUncertain.request.questions.click_target.criteria, false);
  assert.equal('none' in builtUncertain.targetFingerprints, false);
  assert.equal('NONE' in builtUncertain.targetFingerprints, false);

  const resNone = JSON.parse(JSON.stringify(validResult));
  resNone.requestId = 'req-101';
  delete resNone.answers.type_text_target; // only 1 element was retained (r5)
  resNone.answers.operation.probabilities = { CLICK: 0.95, WAIT: 0.02, DONE: 0.02, BLOCKED: 0.01 };
  resNone.answers.click_target.choice = 'none';
  resNone.answers.click_target.probabilities = { r5: 0.1, none: 0.9 };
  const v9 = validateShadowDecision(resNone, {
    request: builtUncertain.request,
    elements: builtUncertain.elements,
    snapshotDigest: builtUncertain.snapshotDigest,
  });
  assert.equal(v9.ok, true);
  assert.equal(v9.actionable, false);
  assert.equal(v9.invalid, false);
  assert.equal(v9.decision.targetRef, null);
  assert.ok(v9.reasons.includes('NO_TARGET'));

  // Rejection of NONE choice: must be rejected as invalid
  const resBadNone = JSON.parse(JSON.stringify(resNone));
  resBadNone.answers.click_target.choice = 'NONE';
  resBadNone.answers.click_target.probabilities = { r5: 0.1, none: 0.9 };
  const vBadNone = validateShadowDecision(resBadNone, {
    request: builtUncertain.request,
    elements: builtUncertain.elements,
    snapshotDigest: builtUncertain.snapshotDigest,
  });
  assert.equal(vBadNone.ok, false);
  assert.equal(vBadNone.invalid, true);
});

test('6. recheck fault matrix (checkbox 8): verifies fault taxonomy', () => {
  const baseSnapshot = '- ref=r5 button "Submit"';
  const norm = normalizeAriaSnapshot(baseSnapshot);
  const r5 = norm.elements[0];
  const fingerprint = 'sha256:' + sha256hex(`${r5.role}\0${r5.name}\0${r5.value}\0${r5.operations.join(',')}`);

  const decision = {
    operation: 'CLICK',
    targetRef: 'r5',
    confidence: 0.95,
    snapshotDigest: norm.snapshotDigest,
    decidedAt: 1000,
    fingerprint,
  };

  // Case 1: Intact -> ok
  const c1 = recheckShadowTarget({
    decision,
    freshSnapshot: baseSnapshot,
    now: 1500,
    ttlMs: 30000,
  });
  assert.equal(c1.ok, true);
  assert.equal(c1.stale, false);
  assert.equal(c1.fault, null);

  // Case 2: Replaced (different name) -> fault 'replaced'
  const c2 = recheckShadowTarget({
    decision,
    freshSnapshot: '- ref=r5 button "Cancel"',
    now: 1500,
    ttlMs: 30000,
  });
  assert.equal(c2.ok, false);
  assert.equal(c2.stale, true);
  assert.equal(c2.fault, 'replaced');
  assert.ok(c2.reasons.includes('TARGET_REPLACED'));

  // Case 3: Hidden (ref disappeared) -> fault 'hidden'
  const c3 = recheckShadowTarget({
    decision,
    freshSnapshot: '- ref=r99 button "Other"',
    now: 1500,
    ttlMs: 30000,
  });
  assert.equal(c3.ok, false);
  assert.equal(c3.stale, true);
  assert.equal(c3.fault, 'hidden');
  assert.ok(c3.reasons.includes('TARGET_HIDDEN'));

  // Case 4: Disabled -> fault 'disabled'
  const c4 = recheckShadowTarget({
    decision,
    freshSnapshot: '- ref=r5 button "Submit" [disabled]',
    now: 1500,
    ttlMs: 30000,
  });
  assert.equal(c4.ok, false);
  assert.equal(c4.stale, true);
  assert.equal(c4.fault, 'disabled');
  assert.ok(c4.reasons.includes('TARGET_DISABLED'));

  // Case 5: Covered -> fault 'covered'
  const c5 = recheckShadowTarget({
    decision,
    freshSnapshot: baseSnapshot,
    coveredRefs: ['r5'],
    now: 1500,
    ttlMs: 30000,
  });
  assert.equal(c5.ok, false);
  assert.equal(c5.stale, true);
  assert.equal(c5.fault, 'covered');
  assert.ok(c5.reasons.includes('TARGET_COVERED'));

  // Case 6: Expired -> fault 'expired'
  const c6 = recheckShadowTarget({
    decision,
    freshSnapshot: baseSnapshot,
    now: 35000,
    ttlMs: 30000,
  });
  assert.equal(c6.ok, false);
  assert.equal(c6.stale, true);
  assert.equal(c6.fault, 'expired');
  assert.ok(c6.reasons.includes('TTL_EXPIRED'));

  // Case 7: Missing/invalid decidedAt -> fault 'unbound', reasons ['BINDING_MISSING']
  const c7 = recheckShadowTarget({
    decision: { ...decision, decidedAt: undefined },
    freshSnapshot: baseSnapshot,
    now: 1500,
    ttlMs: 30000,
  });
  assert.equal(c7.ok, false);
  assert.equal(c7.stale, true);
  assert.equal(c7.fault, 'unbound');
  assert.deepEqual(c7.reasons, ['BINDING_MISSING']);

  // Case 8: Missing/invalid fingerprint -> fault 'unbound', reasons ['BINDING_MISSING']
  const c8 = recheckShadowTarget({
    decision: { ...decision, fingerprint: null },
    freshSnapshot: baseSnapshot,
    now: 1500,
    ttlMs: 30000,
  });
  assert.equal(c8.ok, false);
  assert.equal(c8.stale, true);
  assert.equal(c8.fault, 'unbound');
  assert.deepEqual(c8.reasons, ['BINDING_MISSING']);
});

test('7. runShadowBrowserStep: queries jev mock, validates, handles errors cleanly', async () => {
  const snapshot = '- ref=r1 button "Confirm"';
  let receivedRequest = null;

  const validResult = {
    schema: 'webmcp-jev-result/1',
    requestId: 'step-1',
    status: 'ok',
    advisoryOnly: true,
    answers: {
      operation: {
        type: 'choice',
        choice: 'CLICK',
        probabilities: { CLICK: 0.9, WAIT: 0.05, DONE: 0.03, BLOCKED: 0.02 },
        confidence: 0.95,
      },
      click_target: {
        type: 'choice',
        choice: 'r1',
        probabilities: { r1: 1.0 },
        confidence: 0.99,
      },
    },
    lineage: {
      provider: 'typesafe',
      model: 'jev-1.0',
      skillDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      questionSetDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      stateDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      requestDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
    timing: { latencyMs: 25, attempts: 1 },
    usage: { inputTokens: 50, outputTokens: 10 },
  };

  const queryMock = async (req) => {
    receivedRequest = req;
    return { result: validResult };
  };

  const record = await runShadowBrowserStep({
    snapshot,
    goal: 'Click confirm',
    requestId: 'step-1',
    urlOrigin: 'https://example.com',
    runId: 'run-test',
    query: queryMock,
    normalAgentDecision: { operation: 'CLICK', targetRef: 'r1' },
  });

  assert.equal(record.schema, SHADOW_RECORD_SCHEMA);
  assert.equal(record.executed, false);
  assert.equal(record.browserActions, 0);
  assert.equal(record.mcpCalls.shadow, 0);
  assert.equal(record.agreement, true);
  assert.equal(record.status, 'ok');
  assert.ok(record.jevDecision);
  assert.equal(record.jevDecision.targetRef, 'r1');
  assert.equal(typeof record.jevDecision.snapshotDigest, 'string');
  assert.ok(record.jevDecision.snapshotDigest.startsWith('sha256:'));
  assert.equal(typeof record.jevDecision.decidedAt, 'number');
  assert.ok(Number.isFinite(record.jevDecision.decidedAt));
  assert.equal(typeof record.jevDecision.fingerprint, 'string');
  assert.ok(record.jevDecision.fingerprint.startsWith('sha256:'));

  // Test: record -> recheckShadowTarget({ decision: record.jevDecision, freshSnapshot: snapshot }) ok; snapshot doi -> stale
  const recheckFresh = recheckShadowTarget({
    decision: record.jevDecision,
    freshSnapshot: snapshot,
  });
  assert.equal(recheckFresh.ok, true);
  assert.equal(recheckFresh.stale, false);
  assert.equal(recheckFresh.fault, null);

  const recheckChanged = recheckShadowTarget({
    decision: record.jevDecision,
    freshSnapshot: '- ref=r1 button "Changed name"',
  });
  assert.equal(recheckChanged.ok, false);
  assert.equal(recheckChanged.stale, true);
  assert.equal(recheckChanged.fault, 'replaced');

  // Direct result unwrapping test (without { result } wrapper)
  const queryDirect = async () => validResult;
  const directRecord = await runShadowBrowserStep({
    snapshot,
    goal: 'Click confirm',
    requestId: 'step-1',
    urlOrigin: 'https://example.com',
    runId: 'run-test',
    query: queryDirect,
  });
  assert.equal(directRecord.status, 'ok');
  assert.equal(directRecord.jevDecision.targetRef, 'r1');

  // Query throw test -> fallback-required with reason QUERY_FAILED:<CODE>
  const queryThrow = async () => {
    const err = new Error('Timeout contacting Jev');
    err.code = 'JEV_TIMEOUT';
    throw err;
  };

  const failRecord = await runShadowBrowserStep({
    snapshot,
    goal: 'Click confirm',
    requestId: 'step-1',
    urlOrigin: 'https://example.com',
    runId: 'run-test',
    query: queryThrow,
  });

  assert.equal(failRecord.status, 'fallback-required');
  assert.equal(failRecord.reason, 'QUERY_FAILED:JEV_TIMEOUT');
  assert.equal(failRecord.jevDecision, null);
  assert.equal(failRecord.agreement, null);
  assert.equal(failRecord.executed, false);
});

test('8. shadow invariant: static analysis and record envelope purity', async () => {
  const code = readFileSync(new URL('../../lib/jev-shadow/loop.mjs', import.meta.url), 'utf8');

  // Assert no forbidden modules or constructs
  assert.equal(code.includes('child_process'), false, 'loop.mjs must not import child_process');
  assert.equal(code.includes('server/'), false, 'loop.mjs must not import server/');
  assert.equal(code.includes('webmcp-extension'), false, 'loop.mjs must not import webmcp-extension');
  assert.equal(/fetch\s*\(/.test(code), false, 'loop.mjs must not invoke fetch(');
  assert.equal(/import\s*\(/.test(code), false, 'loop.mjs must not use dynamic import(');

  // Assert record does not contain authority fields
  const record = await runShadowBrowserStep({
    snapshot: '- ref=r1 button "Go"',
    goal: 'Test authority fields',
    requestId: 'step-auth',
    urlOrigin: 'https://example.com',
    runId: 'run-1',
    query: async () => ({
      schema: 'webmcp-jev-result/1',
      requestId: 'step-auth',
      status: 'ok',
      advisoryOnly: true,
      answers: {
        operation: { type: 'choice', choice: 'WAIT', probabilities: { WAIT: 1.0 }, confidence: 1.0 },
      },
      lineage: {
        provider: 'typesafe',
        model: 'jev-1.0',
        skillDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        questionSetDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        stateDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        requestDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      },
      timing: { latencyMs: 10, attempts: 1 },
      usage: { inputTokens: 10, outputTokens: 10 },
    }),
  });

  const forbiddenKeys = ['approved', 'allowed', 'passed', 'done', 'solved'];
  for (const key of forbiddenKeys) {
    assert.equal(key in record, false, `Record must not contain authority key "${key}"`);
  }
  assert.equal('advisoryOnly' in record, false, 'Record is an audit record, not an authority envelope');
});

test('9. note truncation: note matching /truncat/i triggers coverageUncertain and offers none', () => {
  const snapshotWithNote = [
    '- ref=r1 button "Option 1"',
    '- note "3 more options truncated"',
  ].join('\n');

  const norm = normalizeAriaSnapshot(snapshotWithNote);
  assert.equal(norm.coverageUncertain, true);
  assert.equal(norm.stats.noteTruncated, 1);

  const built = buildBrowserStepRequest({
    snapshot: snapshotWithNote,
    goal: 'Select option',
    requestId: 'req-trunc',
    urlOrigin: 'https://example.com',
    runId: 'run-trunc',
  });

  assert.equal(built.coverageUncertain, true);
  assert.equal('none' in built.request.questions.click_target.criteria, true);
  assert.equal('NONE' in built.request.questions.click_target.criteria, false);
  assert.equal('none' in built.targetFingerprints, false);
  assert.equal('NONE' in built.targetFingerprints, false);
});

test('10. validate: partial fan-out answers and unused heads rules (W1R2)', () => {
  const snapshot = '- ref=r5 button "Submit"\n- ref=r6 textbox "Email"';
  const built = buildBrowserStepRequest({
    snapshot,
    goal: 'Submit form',
    requestId: 'req-w1r2',
    urlOrigin: 'https://example.com',
    runId: 'run-w1r2',
  });

  const baseAnswers = {
    operation: {
      type: 'choice',
      choice: 'CLICK',
      probabilities: { CLICK: 0.9, TYPE_TEXT: 0.05, WAIT: 0.02, DONE: 0.02, BLOCKED: 0.01 },
      confidence: 0.95,
    },
    click_target: {
      type: 'choice',
      choice: 'r5',
      probabilities: { r5: 1.0 },
      confidence: 0.98,
    },
  };

  const createResult = (answers) => ({
    schema: 'webmcp-jev-result/1',
    requestId: 'req-w1r2',
    status: 'ok',
    advisoryOnly: true,
    answers,
    lineage: {
      provider: 'typesafe',
      model: 'jev-1.0',
      skillDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      questionSetDigest: built.request.questionSet.digest,
      stateDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      requestDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
    timing: { latencyMs: 30, attempts: 1 },
    usage: { inputTokens: 60, outputTokens: 15 },
  });

  // (1) partial: chỉ operation + head target của op được chọn → ok:true, actionable:true
  const vPartial = validateShadowDecision(createResult({ ...baseAnswers }), {
    request: built.request,
    elements: built.elements,
    snapshotDigest: built.snapshotDigest,
  });
  assert.equal(vPartial.ok, true);
  assert.equal(vPartial.actionable, true);
  assert.equal(vPartial.invalid, false);
  assert.equal(vPartial.stale, false);
  assert.equal(vPartial.decision.operation, 'CLICK');
  assert.equal(vPartial.decision.targetRef, 'r5');

  // (2) partial + control op (WAIT) chỉ có operation → ok:true, actionable:true, targetRef:null
  const vControlWait = validateShadowDecision(
    createResult({
      operation: {
        type: 'choice',
        choice: 'WAIT',
        probabilities: { CLICK: 0.05, TYPE_TEXT: 0.05, WAIT: 0.85, DONE: 0.03, BLOCKED: 0.02 },
        confidence: 0.92,
      },
    }),
    {
      request: built.request,
      elements: built.elements,
      snapshotDigest: built.snapshotDigest,
    }
  );
  assert.equal(vControlWait.ok, true);
  assert.equal(vControlWait.actionable, true);
  assert.equal(vControlWait.invalid, false);
  assert.equal(vControlWait.stale, false);
  assert.equal(vControlWait.decision.operation, 'WAIT');
  assert.equal(vControlWait.decision.targetRef, null);

  // (3) id lạ trong answers → ANSWER_INVALID
  const vForeignId = validateShadowDecision(
    createResult({
      ...baseAnswers,
      unknown_foreign_head: {
        type: 'choice',
        choice: 'r5',
        probabilities: { r5: 1.0 },
        confidence: 0.9,
      },
    }),
    {
      request: built.request,
      elements: built.elements,
      snapshotDigest: built.snapshotDigest,
    }
  );
  assert.equal(vForeignId.ok, false);
  assert.equal(vForeignId.invalid, true);
  assert.ok(vForeignId.reasons.includes('ANSWER_INVALID'));

  // (4) action op thiếu head target → ANSWER_INVALID
  const vMissingTarget = validateShadowDecision(
    createResult({
      operation: {
        type: 'choice',
        choice: 'CLICK',
        probabilities: { CLICK: 0.9, TYPE_TEXT: 0.05, WAIT: 0.02, DONE: 0.02, BLOCKED: 0.01 },
        confidence: 0.95,
      },
    }),
    {
      request: built.request,
      elements: built.elements,
      snapshotDigest: built.snapshotDigest,
    }
  );
  assert.equal(vMissingTarget.ok, false);
  assert.equal(vMissingTarget.invalid, true);
  assert.ok(vMissingTarget.reasons.includes('ANSWER_INVALID'));

  // (5) unused head có mặt nhưng probabilities sai (sum lệch) → ANSWER_INVALID
  const vBadUnused = validateShadowDecision(
    createResult({
      ...baseAnswers,
      type_text_target: {
        type: 'choice',
        choice: 'r6',
        probabilities: { r6: 0.5 },
        confidence: 0.88,
      },
    }),
    {
      request: built.request,
      elements: built.elements,
      snapshotDigest: built.snapshotDigest,
    }
  );
  assert.equal(vBadUnused.ok, false);
  assert.equal(vBadUnused.invalid, true);
  assert.ok(vBadUnused.reasons.includes('ANSWER_INVALID'));

  // (6) unused head có mặt và hợp lệ → vẫn ok:true (không bị coi là lỗi)
  const vValidUnused = validateShadowDecision(
    createResult({
      ...baseAnswers,
      type_text_target: {
        type: 'choice',
        choice: 'r6',
        probabilities: { r6: 1.0 },
        confidence: 0.95,
      },
    }),
    {
      request: built.request,
      elements: built.elements,
      snapshotDigest: built.snapshotDigest,
    }
  );
  assert.equal(vValidUnused.ok, true);
  assert.equal(vValidUnused.actionable, true);
  assert.equal(vValidUnused.invalid, false);
  assert.equal(vValidUnused.stale, false);
  assert.equal(vValidUnused.decision.operation, 'CLICK');
  assert.equal(vValidUnused.decision.targetRef, 'r5');
});

test('11. fail-closed goal guard: classifies BLOCK/SAFE goals, rejects leakage, and runner fails closed', async () => {
  const blockGoals = [
    'Resume session token=3f9a1c2b4d5e6f708192a3b4c5d6e7f8',
    'Login password=hunter22',
    'Mật khẩu: hunter22',
    'Enter OTP 482913',
    'Paste the JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcGVyYXRvciJ9.c2lnbmF0dXJl',
    'Use key sk-test-abcdef123456',
    'Card 4111 1111 1111 1111',
  ];

  const safeGoals = [
    'Open the password settings page',
    'Reset your password',
    'Sign in with the operator account',
    'Minimum 8 characters',
    'Accept all cookies',
    'Go to Next page',
    'Enter the verification code sent to your email',
    'Đăng nhập bằng tài khoản vận hành',
  ];

  // Verify pattern exports
  assert.ok(Array.isArray(GOAL_SECRET_PATTERNS) || Object.isFrozen(GOAL_SECRET_PATTERNS));
  assert.ok(GOAL_SECRET_PATTERNS.length >= 8);

  // Exact classification check
  for (const bg of blockGoals) {
    assert.equal(goalCarriesSecret(bg), true, `Goal should be BLOCK: "${bg}"`);
    assert.throws(
      () => buildBrowserStepRequest({
        snapshot: '- ref=r1 button "Confirm"',
        goal: bg,
        requestId: 'req-bg',
        urlOrigin: 'https://example.com',
        runId: 'run-1',
      }),
      (err) => {
        assert.equal(err.code, 'REQUEST_INVALID');
        assert.match(err.message, /goal carries secret-shaped text; pass a high-level intent only/);
        return true;
      },
      `buildBrowserStepRequest must throw for BLOCK goal "${bg}"`
    );
  }

  for (const sg of safeGoals) {
    assert.equal(goalCarriesSecret(sg), false, `Goal should be SAFE: "${sg}"`);
    assert.doesNotThrow(() => buildBrowserStepRequest({
      snapshot: '- ref=r1 button "Confirm"',
      goal: sg,
      requestId: 'req-sg',
      urlOrigin: 'https://example.com',
      runId: 'run-1',
    }), `buildBrowserStepRequest must not throw for SAFE goal "${sg}"`);
  }

  // Runner fail-closed: goal BLOCK -> record như mục 3, query counter = 0
  for (const bg of blockGoals) {
    let queryCalls = 0;
    const queryStub = async () => {
      queryCalls++;
      return { status: 'ok' };
    };

    const record = await runShadowBrowserStep({
      snapshot: '- ref=r1 button "Confirm"',
      goal: bg,
      requestId: 'req-block-runner',
      urlOrigin: 'https://example.com',
      runId: 'run-block',
      query: queryStub,
      normalAgentDecision: { operation: 'CLICK', targetRef: 'r1' },
      postcondition: { check: true },
    });

    assert.equal(queryCalls, 0, 'query counter must be 0 for BLOCK goal');
    assert.equal(record.schema, SHADOW_RECORD_SCHEMA);
    assert.equal(record.status, 'fallback-required');
    assert.equal(record.reason, 'BUILD_FAILED:UNKNOWN');
    assert.equal(record.jevDecision, null);
    assert.equal(record.lineage, null);
    assert.equal(record.agreement, null);
    assert.equal(record.snapshotDigest, null);
    assert.equal(record.questionSetDigest, null);
    assert.equal(record.executed, false);
    assert.equal(record.browserActions, 0);
    assert.deepEqual(record.mcpCalls, { shadow: 0, browserActions: 0 });
    assert.equal(record.timing.buildMs, 0);
    assert.equal(record.timing.validateMs, 0);
    assert.equal(record.timing.queryMs, 0);
    assert.equal(record.timing.overheadMs, 0);
    assert.equal(record.timing.totalMs, 0);
  }

  // Control: goal SAFE + query hợp lệ -> record ok
  const validResult = {
    schema: 'webmcp-jev-result/1',
    requestId: 'req-control',
    status: 'ok',
    advisoryOnly: true,
    answers: {
      operation: {
        type: 'choice',
        choice: 'CLICK',
        probabilities: { CLICK: 0.9, WAIT: 0.05, DONE: 0.03, BLOCKED: 0.02 },
        confidence: 0.95,
      },
      click_target: {
        type: 'choice',
        choice: 'r1',
        probabilities: { r1: 1.0 },
        confidence: 0.98,
      },
    },
    lineage: {
      provider: 'typesafe',
      model: 'jev-1.0',
      skillDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      questionSetDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      stateDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      requestDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
    timing: { latencyMs: 20, attempts: 1 },
    usage: { inputTokens: 50, outputTokens: 10 },
  };

  let controlQueryCalls = 0;
  const controlQuery = async () => {
    controlQueryCalls++;
    return validResult;
  };

  const controlRecord = await runShadowBrowserStep({
    snapshot: '- ref=r1 button "Confirm"',
    goal: 'Sign in with the operator account',
    requestId: 'req-control',
    urlOrigin: 'https://example.com',
    runId: 'run-control',
    query: controlQuery,
    normalAgentDecision: { operation: 'CLICK', targetRef: 'r1' },
  });

  assert.equal(controlQueryCalls, 1);
  assert.equal(controlRecord.status, 'ok');
  assert.equal(controlRecord.reason, null);
  assert.ok(controlRecord.jevDecision);
  assert.equal(controlRecord.agreement, true);
  assert.equal(controlRecord.jevDecision.valid, true);
  assert.equal(controlRecord.jevDecision.actionable, true);
  assert.equal(controlRecord.jevDecision.targetRef, 'r1');
});

test('12. ttl freshness: boundAt starts at snapshot build, slow query triggers TTL_EXPIRED and recheck failure', async () => {
  const T0 = 100000;
  const ttlMs = 500;
  const snapshot = '- ref=r1 button "Confirm"';

  const built = buildBrowserStepRequest({
    snapshot,
    goal: 'Click confirm',
    requestId: 'req-ttl',
    urlOrigin: 'https://example.com',
    runId: 'run-ttl',
  });

  const validResult = {
    schema: 'webmcp-jev-result/1',
    requestId: 'req-ttl',
    status: 'ok',
    advisoryOnly: true,
    answers: {
      operation: {
        type: 'choice',
        choice: 'CLICK',
        probabilities: { CLICK: 0.9, WAIT: 0.05, DONE: 0.03, BLOCKED: 0.02 },
        confidence: 0.95,
      },
      click_target: {
        type: 'choice',
        choice: 'r1',
        probabilities: { r1: 1.0 },
        confidence: 0.99,
      },
    },
    lineage: {
      provider: 'typesafe',
      model: 'jev-1.0',
      skillDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      questionSetDigest: built.request.questionSet.digest,
      stateDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      requestDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
    timing: { latencyMs: 20, attempts: 1 },
    usage: { inputTokens: 50, outputTokens: 10 },
  };

  // 1. unit: validateShadowDecision(result, { …, boundAt: T0, now: T0 + ttlMs + 1 })
  const vUnit = validateShadowDecision(validResult, {
    request: built.request,
    elements: built.elements,
    snapshotDigest: built.snapshotDigest,
    boundAt: T0,
    now: T0 + ttlMs + 1,
    ttlMs,
  });
  assert.equal(vUnit.stale, true);
  assert.ok(vUnit.reasons.includes('TTL_EXPIRED'));
  assert.equal(vUnit.decision.decidedAt, T0);

  // 2. runner: dùng now injectable trả chuỗi thời gian (let clock = T0; now = () => clock;), ttlMs: 500;
  // query là async nhưng trước khi validate ta set clock = T0 + 60_000 (mô phỏng query 60 s).
  let clock = T0;
  const now = () => clock;

  const slowQuery = async () => {
    clock = T0 + 60_000;
    return validResult;
  };

  const record = await runShadowBrowserStep({
    snapshot,
    goal: 'Click confirm',
    requestId: 'req-ttl',
    urlOrigin: 'https://example.com',
    runId: 'run-ttl',
    query: slowQuery,
    now,
    ttlMs,
    normalAgentDecision: { operation: 'CLICK', targetRef: 'r1' },
  });

  assert.equal(record.jevDecision.stale, true);
  assert.ok(record.jevDecision.reasons.includes('TTL_EXPIRED'));
  assert.equal(record.jevDecision.decidedAt, T0);

  // 3. recheck sau đó: recheckShadowTarget({ decision: record.jevDecision, freshSnapshot: snapshot, now: T0 + 60_000, ttlMs: 500 })
  const recheck = recheckShadowTarget({
    decision: record.jevDecision,
    freshSnapshot: snapshot,
    now: T0 + 60_000,
    ttlMs: 500,
  });
  assert.equal(recheck.ok, false);
  assert.equal(recheck.stale, true);
  assert.equal(recheck.fault, 'expired');
  assert.ok(recheck.reasons.includes('TTL_EXPIRED'));

  // 4. Control: query nhanh (clock không đổi) + ttlMs: 500 → record ok, decidedAt === T0, recheck ok
  clock = T0;
  const fastQuery = async () => validResult;

  const controlRecord = await runShadowBrowserStep({
    snapshot,
    goal: 'Click confirm',
    requestId: 'req-ttl',
    urlOrigin: 'https://example.com',
    runId: 'run-ttl',
    query: fastQuery,
    now,
    ttlMs,
    normalAgentDecision: { operation: 'CLICK', targetRef: 'r1' },
  });

  assert.equal(controlRecord.status, 'ok');
  assert.equal(controlRecord.jevDecision.valid, true);
  assert.equal(controlRecord.jevDecision.stale, false);
  assert.equal(controlRecord.jevDecision.reasons.includes('TTL_EXPIRED'), false);
  assert.equal(controlRecord.jevDecision.decidedAt, T0);

  const controlRecheck = recheckShadowTarget({
    decision: controlRecord.jevDecision,
    freshSnapshot: snapshot,
    now: T0,
    ttlMs: 500,
  });
  assert.equal(controlRecheck.ok, true);
  assert.equal(controlRecheck.stale, false);
  assert.equal(controlRecheck.fault, null);

  // 5. Counterexample Sol: snapshotCapturedAt: 100000, now: () => 160000, ttlMs: 500, query instant hợp lệ
  // ⇒ record.jevDecision.stale === true, reasons chứa TTL_EXPIRED, record.jevDecision.decidedAt === 100000, record.snapshotCapturedAt === 100000;
  // recheckShadowTarget({decision: record.jevDecision, freshSnapshot, now: 160000, ttlMs: 500}) ⇒ fault:'expired'.
  const solCaptureRecord = await runShadowBrowserStep({
    snapshot,
    snapshotCapturedAt: 100000,
    goal: 'Click confirm',
    requestId: 'req-ttl-sol',
    urlOrigin: 'https://example.com',
    runId: 'run-ttl',
    query: async (req) => ({ ...validResult, requestId: req.requestId }),
    now: () => 160000,
    ttlMs: 500,
    normalAgentDecision: { operation: 'CLICK', targetRef: 'r1' },
  });

  assert.equal(solCaptureRecord.jevDecision.stale, true);
  assert.ok(solCaptureRecord.jevDecision.reasons.includes('TTL_EXPIRED'));
  assert.equal(solCaptureRecord.jevDecision.decidedAt, 100000);
  assert.equal(solCaptureRecord.snapshotCapturedAt, 100000);

  const solRecheck = recheckShadowTarget({
    decision: solCaptureRecord.jevDecision,
    freshSnapshot: snapshot,
    now: 160000,
    ttlMs: 500,
  });
  assert.equal(solRecheck.ok, false);
  assert.equal(solRecheck.stale, true);
  assert.equal(solRecheck.fault, 'expired');
  assert.ok(solRecheck.reasons.includes('TTL_EXPIRED'));

  // 6. Dạng object: snapshot: { snapshot: <text>, capturedAt: 100000 } + now:160000 + ttlMs:500 ⇒ stale TTL_EXPIRED, decidedAt === 100000
  const objCaptureRecord = await runShadowBrowserStep({
    snapshot: { snapshot, capturedAt: 100000 },
    goal: 'Click confirm',
    requestId: 'req-ttl-obj',
    urlOrigin: 'https://example.com',
    runId: 'run-ttl',
    query: async (req) => ({ ...validResult, requestId: req.requestId }),
    now: () => 160000,
    ttlMs: 500,
    normalAgentDecision: { operation: 'CLICK', targetRef: 'r1' },
  });

  assert.equal(objCaptureRecord.jevDecision.stale, true);
  assert.ok(objCaptureRecord.jevDecision.reasons.includes('TTL_EXPIRED'));
  assert.equal(objCaptureRecord.jevDecision.decidedAt, 100000);
  assert.equal(objCaptureRecord.snapshotCapturedAt, 100000);

  // 7. Control: snapshotCapturedAt = now (cách đây < ttl) ⇒ ok, không stale
  const freshCaptureRecord = await runShadowBrowserStep({
    snapshot,
    snapshotCapturedAt: 160000,
    goal: 'Click confirm',
    requestId: 'req-ttl-fresh',
    urlOrigin: 'https://example.com',
    runId: 'run-ttl',
    query: async (req) => ({ ...validResult, requestId: req.requestId }),
    now: () => 160000,
    ttlMs: 500,
    normalAgentDecision: { operation: 'CLICK', targetRef: 'r1' },
  });

  assert.equal(freshCaptureRecord.status, 'ok');
  assert.equal(freshCaptureRecord.jevDecision.stale, false);
  assert.equal(freshCaptureRecord.jevDecision.reasons.includes('TTL_EXPIRED'), false);
  assert.equal(freshCaptureRecord.jevDecision.decidedAt, 160000);
  assert.equal(freshCaptureRecord.snapshotCapturedAt, 160000);

  // 8. snapshotCapturedAt: 'abc' ⇒ throw REQUEST_INVALID
  await assert.rejects(
    runShadowBrowserStep({
      snapshot,
      snapshotCapturedAt: 'abc',
      goal: 'Click confirm',
      requestId: 'req-ttl-invalid',
      urlOrigin: 'https://example.com',
      runId: 'run-ttl',
      query: async (req) => ({ ...validResult, requestId: req.requestId }),
    }),
    (err) => {
      assert.equal(err.code, 'REQUEST_INVALID');
      assert.match(err.message, /snapshotCapturedAt must be a finite epoch-ms number/);
      return true;
    }
  );

  // 9. Object snapshot with capturedAt: 'abc' ⇒ throw REQUEST_INVALID
  await assert.rejects(
    runShadowBrowserStep({
      snapshot: { snapshot, capturedAt: 'abc' },
      goal: 'Click confirm',
      requestId: 'req-ttl-invalid-obj',
      urlOrigin: 'https://example.com',
      runId: 'run-ttl',
      query: async () => validResult,
    }),
    (err) => {
      assert.equal(err.code, 'REQUEST_INVALID');
      assert.match(err.message, /snapshotCapturedAt must be a finite epoch-ms number/);
      return true;
    }
  );
});

test('13. invalid result status: invalid validation records status "invalid" and INVALID_RESULT reason, agreement is null; NO_TARGET control stays "ok"', async () => {
  const snapshot = '- ref=r1 button "Confirm"';

  // 1. Query returning invalid result (probabilities sum lệch > 0.02)
  const invalidResult = {
    schema: 'webmcp-jev-result/1',
    requestId: 'req-inv-1',
    status: 'ok',
    advisoryOnly: true,
    answers: {
      operation: {
        type: 'choice',
        choice: 'CLICK',
        probabilities: { CLICK: 0.95, WAIT: 0.1, DONE: 0.03, BLOCKED: 0.02 }, // sum = 1.10 > 1.02
        confidence: 0.95,
      },
      click_target: {
        type: 'choice',
        choice: 'r1',
        probabilities: { r1: 1.0 },
        confidence: 0.99,
      },
    },
    lineage: {
      provider: 'typesafe',
      model: 'jev-1.0',
      skillDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      questionSetDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      stateDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      requestDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
    timing: { latencyMs: 20, attempts: 1 },
    usage: { inputTokens: 50, outputTokens: 10 },
  };

  const recordInvalid = await runShadowBrowserStep({
    snapshot,
    goal: 'Click confirm',
    requestId: 'req-inv-1',
    urlOrigin: 'https://example.com',
    runId: 'run-inv-1',
    query: async () => invalidResult,
    normalAgentDecision: { engine: 'normal-agent', operation: 'CLICK', targetRef: 'r1' },
  });

  assert.equal(recordInvalid.status, 'invalid');
  assert.equal(recordInvalid.reason, 'INVALID_RESULT');
  assert.equal(recordInvalid.jevDecision.valid, false);
  assert.equal(recordInvalid.jevDecision.invalid, true);
  assert.equal(recordInvalid.agreement, null);

  // 2. Control: NO_TARGET (ok/không actionable) vẫn status: "ok"
  const snapshotTruncated = '- ref=r1 button "Confirm"\n- note "3 more options truncated"';
  const noTargetResult = {
    schema: 'webmcp-jev-result/1',
    requestId: 'req-notarget-1',
    status: 'ok',
    advisoryOnly: true,
    answers: {
      operation: {
        type: 'choice',
        choice: 'CLICK',
        probabilities: { CLICK: 0.9, WAIT: 0.05, DONE: 0.03, BLOCKED: 0.02 },
        confidence: 0.95,
      },
      click_target: {
        type: 'choice',
        choice: 'none',
        probabilities: { r1: 0.1, none: 0.9 },
        confidence: 0.99,
      },
    },
    lineage: {
      provider: 'typesafe',
      model: 'jev-1.0',
      skillDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      questionSetDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      stateDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      requestDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
    timing: { latencyMs: 20, attempts: 1 },
    usage: { inputTokens: 50, outputTokens: 10 },
  };

  const recordNoTarget = await runShadowBrowserStep({
    snapshot: snapshotTruncated,
    goal: 'Click confirm',
    requestId: 'req-notarget-1',
    urlOrigin: 'https://example.com',
    runId: 'run-notarget-1',
    query: async () => noTargetResult,
    normalAgentDecision: { engine: 'normal-agent', operation: 'CLICK', targetRef: 'r1' },
  });

  assert.equal(recordNoTarget.status, 'ok');
  assert.equal(recordNoTarget.reason, null);
  assert.equal(recordNoTarget.jevDecision.valid, true);
  assert.equal(recordNoTarget.jevDecision.actionable, false);
  assert.equal(recordNoTarget.agreement, null);
});

test('14. evidence whitelist and scrub: strips secrets and unwhitelisted fields from normalAgentDecision and postcondition', async () => {
  const snapshot = '- ref=r3 button "Confirm"';

  const validResult = {
    schema: 'webmcp-jev-result/1',
    requestId: 'req-sec-1',
    status: 'ok',
    advisoryOnly: true,
    answers: {
      operation: {
        type: 'choice',
        choice: 'CLICK',
        probabilities: { CLICK: 0.9, WAIT: 0.05, DONE: 0.03, BLOCKED: 0.02 },
        confidence: 0.95,
      },
      click_target: {
        type: 'choice',
        choice: 'r3',
        probabilities: { r3: 1.0 },
        confidence: 0.99,
      },
    },
    lineage: {
      provider: 'typesafe',
      model: 'jev-1.0',
      skillDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      questionSetDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      stateDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      requestDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
    timing: { latencyMs: 20, attempts: 1 },
    usage: { inputTokens: 50, outputTokens: 10 },
  };

  // 1. normalAgentDecision with secret in text and values
  const normalAgentDecision = {
    engine: 'normal-agent',
    operation: 'CLICK',
    targetRef: 'r3',
    text: 'password=hunter22',
    values: ['token=3f9a1c2b4d5e6f708192a3b4c5d6e7f8'],
  };

  const recordNormal = await runShadowBrowserStep({
    snapshot,
    goal: 'Click confirm',
    requestId: 'req-sec-1',
    urlOrigin: 'https://example.com',
    runId: 'run-sec-1',
    query: async () => validResult,
    normalAgentDecision,
  });

  assert.deepEqual(recordNormal.normalAgentDecision, {
    engine: 'normal-agent',
    operation: 'CLICK',
    targetRef: 'r3',
  });
  const normalEvidence = shadowEvidenceLine(recordNormal);
  assert.equal(normalEvidence.includes('hunter22'), false);
  assert.equal(normalEvidence.includes('password='), false);
  assert.equal(normalEvidence.includes('token='), false);

  // 2. postcondition with secret in method and detail
  const postcondition = {
    verified: true,
    method: 'session=abc123def456',
    satisfied: true,
    detail: 'Login password=hunter22',
  };

  const recordPost = await runShadowBrowserStep({
    snapshot,
    goal: 'Click confirm',
    requestId: 'req-sec-2',
    urlOrigin: 'https://example.com',
    runId: 'run-sec-2',
    query: async () => validResult,
    postcondition,
  });

  assert.deepEqual(recordPost.postcondition, {
    verified: true,
    method: '[REDACTED]',
    satisfied: true,
  });
  const postEvidence = shadowEvidenceLine(recordPost);
  assert.equal(postEvidence.includes('hunter22'), false);
  assert.equal(postEvidence.includes('password='), false);
  assert.equal(postEvidence.includes('abc123def456'), false);
  assert.equal(postEvidence.includes('session='), false);

  // 3. scrubEvidenceText control: does not over-redact
  assert.equal(scrubEvidenceText('Accept all cookies'), 'Accept all cookies');

  // 4. projectNormalAgentDecision with secret targetRef
  const projTarget = projectNormalAgentDecision({
    targetRef: 'token=3f9a1c2b4d5e6f708192a3b4c5d6e7f8',
  });
  assert.equal(projTarget.targetRef, '[REDACTED]');

  // 5. normalAgentDecision.engine === 'normal-agent password hunter22' ⇒ record engine === '[REDACTED]'; shadowEvidenceLine(record) KHÔNG chứa 'hunter22'
  const recordBadEngine = await runShadowBrowserStep({
    snapshot,
    goal: 'Click confirm',
    requestId: 'req-sec-engine',
    urlOrigin: 'https://example.com',
    runId: 'run-sec-engine',
    query: async () => validResult,
    normalAgentDecision: {
      engine: 'normal-agent password hunter22',
      operation: 'CLICK',
      targetRef: 'r3',
    },
  });
  assert.equal(recordBadEngine.normalAgentDecision.engine, '[REDACTED]');
  const lineBadEngine = shadowEvidenceLine(recordBadEngine);
  assert.equal(lineBadEngine.includes('hunter22'), false);

  // 6. postcondition.method === 'Login password hunter22' ⇒ method === '[REDACTED]'; evidence line sạch
  const recordBadMethod = await runShadowBrowserStep({
    snapshot,
    goal: 'Click confirm',
    requestId: 'req-sec-method',
    urlOrigin: 'https://example.com',
    runId: 'run-sec-method',
    query: async () => validResult,
    postcondition: {
      verified: true,
      method: 'Login password hunter22',
      satisfied: true,
    },
  });
  assert.equal(recordBadMethod.postcondition.method, '[REDACTED]');
  const lineBadMethod = shadowEvidenceLine(recordBadMethod);
  assert.equal(lineBadMethod.includes('hunter22'), false);

  // 7. Control pass-through: engine:'normal-agent', operation:'CLICK', targetRef:'r3', method:'snapshot-diff' giữ nguyên; method:'snapshot-diff' thuộc METHOD_VALUES ✓
  assert.equal(METHOD_VALUES.includes('snapshot-diff'), true);
  const recordControlPass = await runShadowBrowserStep({
    snapshot,
    goal: 'Click confirm',
    requestId: 'req-sec-control-pass',
    urlOrigin: 'https://example.com',
    runId: 'run-sec-control-pass',
    query: async () => validResult,
    normalAgentDecision: {
      engine: 'normal-agent',
      operation: 'CLICK',
      targetRef: 'r3',
    },
    postcondition: {
      verified: true,
      method: 'snapshot-diff',
      satisfied: true,
    },
  });
  assert.equal(recordControlPass.normalAgentDecision.engine, 'normal-agent');
  assert.equal(recordControlPass.normalAgentDecision.operation, 'CLICK');
  assert.equal(recordControlPass.normalAgentDecision.targetRef, 'r3');
  assert.equal(recordControlPass.postcondition.method, 'snapshot-diff');
  assert.equal(recordControlPass.postcondition.verified, true);
  assert.equal(recordControlPass.postcondition.satisfied, true);

  // 8. method:'eyJhbGciOiJIUzI1NiJ9.x.y' (JWT) ⇒ '[REDACTED]' (JWT không thuộc METHOD_VALUES, bị scrubEvidenceText chặn; kiểm cả 2 lớp)
  const jwtMethod = 'eyJhbGciOiJIUzI1NiJ9.x.y';
  assert.equal(METHOD_VALUES.includes(jwtMethod), false);
  assert.equal(scrubEvidenceText(jwtMethod), '[REDACTED]');
  const projJwt = projectPostcondition({
    method: jwtMethod,
  });
  assert.equal(projJwt.method, '[REDACTED]');

  const recordJwt = await runShadowBrowserStep({
    snapshot,
    goal: 'Click confirm',
    requestId: 'req-sec-jwt',
    urlOrigin: 'https://example.com',
    runId: 'run-sec-jwt',
    query: async () => validResult,
    postcondition: {
      method: jwtMethod,
    },
  });
  assert.equal(recordJwt.postcondition.method, '[REDACTED]');
  const lineJwt = shadowEvidenceLine(recordJwt);
  assert.equal(lineJwt.includes('eyJhbGciOiJIUzI1NiJ9'), false);

  // 9. Constants and projections coverage
  assert.ok(Object.isFrozen(ENGINE_VALUES));
  assert.ok(Object.isFrozen(OPERATION_VALUES));
  assert.deepEqual(ENGINE_VALUES, ['jev', 'normal-agent', 'deterministic', 'human', 'blocked', 'jev-shadow']);
  assert.deepEqual(OPERATION_VALUES, ['CLICK', 'TYPE_TEXT', 'HOVER', 'SELECT', 'WAIT', 'DONE', 'BLOCKED']);

  // engine fallback to 'normal-agent' on null or empty
  assert.equal(projectNormalAgentDecision({ engine: null }).engine, 'normal-agent');
  assert.equal(projectNormalAgentDecision({ engine: '' }).engine, 'normal-agent');
  assert.equal(projectNormalAgentDecision({ engine: '   ' }).engine, 'normal-agent');

  // operation invalid value -> '[REDACTED]', null -> null
  assert.equal(projectNormalAgentDecision({ operation: 'INVALID_OP' }).operation, '[REDACTED]');
  assert.equal(projectNormalAgentDecision({ operation: null }).operation, null);

  // targetRef long (>64) -> '[REDACTED]', null -> null
  assert.equal(projectNormalAgentDecision({ targetRef: 'r'.repeat(65) }).targetRef, '[REDACTED]');
  assert.equal(projectNormalAgentDecision({ targetRef: null }).targetRef, null);

  // postcondition method null -> null
  assert.equal(projectPostcondition({ method: null }).method, null);
});

test('15. Sol L1 round 2: đóng hẳn evidence fields (targetRef theo snapshot, method closed set, lineage, reason)', async () => {
  const snapshot = '- ref=r3 button "Confirm"\n- ref=r4 textbox "Username" value="user1"';

  const validResult = {
    schema: 'webmcp-jev-result/1',
    requestId: 'req-l1-round2',
    status: 'ok',
    advisoryOnly: true,
    answers: {
      operation: {
        type: 'choice',
        choice: 'CLICK',
        probabilities: { CLICK: 1.0 },
        confidence: 0.95,
      },
      click_target: {
        type: 'choice',
        choice: 'r3',
        probabilities: { r3: 1.0 },
        confidence: 0.99,
      },
    },
    lineage: {
      provider: 'typesafe',
      model: 'jev-1.13.0',
      skillDigest: 'sha256:' + '0'.repeat(64),
      questionSetDigest: 'sha256:' + 'a'.repeat(64),
      stateDigest: 'sha256:' + 'b'.repeat(64),
      requestDigest: 'sha256:' + 'c'.repeat(64),
    },
    timing: { latencyMs: 20, attempts: 1 },
    usage: { inputTokens: 50, outputTokens: 10 },
  };

  // 0. METHOD_VALUES is frozen and has expected items
  assert.ok(Object.isFrozen(METHOD_VALUES));
  assert.deepEqual(METHOD_VALUES, [
    'snapshot-diff',
    'snapshot-verify',
    'dom-check',
    'text-match',
    'url-match',
    'attribute-check',
    'manual',
    'unknown',
  ]);

  // 1. Sol L1-2: runner với normalAgentDecision:{targetRef:'password-hunter22'} và postcondition:{method:'password-hunter22'} (2 input riêng)
  // Input 1: normalAgentDecision:{targetRef:'password-hunter22'}
  const recBadTarget = await runShadowBrowserStep({
    snapshot,
    goal: 'Click confirm',
    requestId: 'req-target-hunter',
    urlOrigin: 'https://example.com',
    runId: 'run-target-hunter',
    query: async () => validResult,
    normalAgentDecision: {
      operation: 'CLICK',
      targetRef: 'password-hunter22',
    },
  });
  assert.equal(recBadTarget.normalAgentDecision.targetRef, '[REDACTED]');
  const lineBadTarget = shadowEvidenceLine(recBadTarget);
  assert.equal(lineBadTarget.includes('hunter22'), false);

  // Input 2: postcondition:{method:'password-hunter22'}
  const recBadMethod = await runShadowBrowserStep({
    snapshot,
    goal: 'Click confirm',
    requestId: 'req-method-hunter',
    urlOrigin: 'https://example.com',
    runId: 'run-method-hunter',
    query: async () => validResult,
    postcondition: {
      verified: true,
      method: 'password-hunter22',
    },
  });
  assert.equal(recBadMethod.postcondition.method, '[REDACTED]');
  const lineBadMethod = shadowEvidenceLine(recBadMethod);
  assert.equal(lineBadMethod.includes('hunter22'), false);

  // 2. Pass-through controls:
  // targetRef:'r3' (r3 có trong snapshot) giữ nguyên
  const recGoodTarget = await runShadowBrowserStep({
    snapshot,
    goal: 'Click confirm',
    requestId: 'req-target-r3',
    urlOrigin: 'https://example.com',
    runId: 'run-target-r3',
    query: async () => validResult,
    normalAgentDecision: {
      operation: 'CLICK',
      targetRef: 'r3',
    },
  });
  assert.equal(recGoodTarget.normalAgentDecision.targetRef, 'r3');

  // method:'snapshot-diff' giữ nguyên
  assert.equal(projectPostcondition({ method: 'snapshot-diff' }).method, 'snapshot-diff');
  const recMethodDiff = await runShadowBrowserStep({
    snapshot,
    goal: 'Click confirm',
    requestId: 'req-method-diff',
    urlOrigin: 'https://example.com',
    runId: 'run-method-diff',
    query: async () => validResult,
    postcondition: {
      method: 'snapshot-diff',
    },
  });
  assert.equal(recMethodDiff.postcondition.method, 'snapshot-diff');

  // method:'custom-check' ⇒ '[REDACTED]'
  assert.equal(projectPostcondition({ method: 'custom-check' }).method, '[REDACTED]');
  const recMethodCustom = await runShadowBrowserStep({
    snapshot,
    goal: 'Click confirm',
    requestId: 'req-method-custom',
    urlOrigin: 'https://example.com',
    runId: 'run-method-custom',
    query: async () => validResult,
    postcondition: {
      method: 'custom-check',
    },
  });
  assert.equal(recMethodCustom.postcondition.method, '[REDACTED]');

  // method:null ⇒ null
  assert.equal(projectPostcondition({ method: null }).method, null);
  const recMethodNull = await runShadowBrowserStep({
    snapshot,
    goal: 'Click confirm',
    requestId: 'req-method-null',
    urlOrigin: 'https://example.com',
    runId: 'run-method-null',
    query: async () => validResult,
    postcondition: {
      method: null,
    },
  });
  assert.equal(recMethodNull.postcondition.method, null);

  // 3. projectNormalAgentDecision({targetRef:'r3'}) không có elementRefs ⇒ '[REDACTED]' (fail closed)
  assert.equal(projectNormalAgentDecision({ targetRef: 'r3' }).targetRef, '[REDACTED]');
  assert.equal(projectNormalAgentDecision({ targetRef: 'r3' }, { elementRefs: null }).targetRef, '[REDACTED]');
  assert.equal(projectNormalAgentDecision({ targetRef: 'r3' }, { elementRefs: new Set(['r3']) }).targetRef, 'r3');
  assert.equal(projectNormalAgentDecision({ targetRef: 'r3' }, { elementRefs: ['r3'] }).targetRef, 'r3');
  assert.equal(projectNormalAgentDecision({ targetRef: 'r3' }, { elementRefs: new Set(['r1']) }).targetRef, '[REDACTED]');
  assert.equal(projectNormalAgentDecision({ targetRef: null }).targetRef, null);

  // 4. Lineage:
  // provider 'password-hunter22' ⇒ '[REDACTED]'
  const badProviderLineage = {
    provider: 'password-hunter22',
    model: 'jev-1.13.0',
    skillDigest: 'sha256:' + '0'.repeat(64),
    questionSetDigest: 'sha256:' + '1'.repeat(64),
    stateDigest: 'sha256:' + '2'.repeat(64),
    requestDigest: 'sha256:' + '3'.repeat(64),
  };
  const projBadProvider = projectLineage(badProviderLineage);
  assert.equal(projBadProvider.provider, '[REDACTED]');

  // model 'password-hunter22' ⇒ '[REDACTED]'
  const projBadModel = projectLineage({ model: 'password-hunter22' });
  assert.equal(projBadModel.model, '[REDACTED]');

  // digest 'password-hunter22' ⇒ '[REDACTED]'
  const projBadDigest = projectLineage({ skillDigest: 'password-hunter22' });
  assert.equal(projBadDigest.skillDigest, '[REDACTED]');

  // control {provider:'typesafe',model:'jev-1.13.0',skillDigest:'sha256:00…',questionSetDigest:'sha256:…',stateDigest:'sha256:…',requestDigest:'sha256:…'} giữ nguyên; evidence line sạch hunter22
  const controlLineage = {
    provider: 'typesafe',
    model: 'jev-1.13.0',
    skillDigest: 'sha256:' + '0'.repeat(64),
    questionSetDigest: 'sha256:' + '1'.repeat(64),
    stateDigest: 'sha256:' + '2'.repeat(64),
    requestDigest: 'sha256:' + '3'.repeat(64),
  };
  const projControl = projectLineage(controlLineage);
  assert.deepEqual(projControl, controlLineage);
  assert.equal(projControl.provider, 'typesafe');
  assert.equal(LINEAGE_PROVIDER, 'typesafe');

  const recGoodLineage = await runShadowBrowserStep({
    snapshot,
    goal: 'Click confirm',
    requestId: 'req-lineage-ctrl',
    urlOrigin: 'https://example.com',
    runId: 'run-lineage-ctrl',
    query: async () => ({
      ...validResult,
      lineage: controlLineage,
    }),
  });
  assert.deepEqual(recGoodLineage.lineage, controlLineage);
  const lineGood = shadowEvidenceLine(recGoodLineage);
  assert.equal(lineGood.includes('hunter22'), false);

  // runner with bad model / digest in lineage
  const recBadLineage = await runShadowBrowserStep({
    snapshot,
    goal: 'Click confirm',
    requestId: 'req-lineage-bad',
    urlOrigin: 'https://example.com',
    runId: 'run-lineage-bad',
    query: async () => ({
      ...validResult,
      lineage: {
        provider: 'typesafe',
        model: 'password-hunter22',
        skillDigest: 'password-hunter22',
        questionSetDigest: 'sha256:' + 'a'.repeat(64),
        stateDigest: 'sha256:' + 'b'.repeat(64),
        requestDigest: 'sha256:' + 'c'.repeat(64),
      },
    }),
  });
  assert.equal(recBadLineage.lineage.model, '[REDACTED]');
  assert.equal(recBadLineage.lineage.skillDigest, '[REDACTED]');
  assert.equal(recBadLineage.lineage.provider, 'typesafe');
  assert.equal(shadowEvidenceLine(recBadLineage).includes('hunter22'), false);

  // Audit toàn record (Sol ask): một ca runner với query giả trả lineage độc hại
  // (provider/model/skillDigest = 'password-hunter22') + normalAgentDecision.targetRef='password-hunter22'
  // + postcondition.method='password-hunter22' ⇒ shadowEvidenceLine(record) KHÔNG chứa 'hunter22';
  // record.lineage.provider/model/skillDigest đều '[REDACTED]'.
  const recAuditMalicious = await runShadowBrowserStep({
    snapshot,
    goal: 'Click confirm',
    requestId: 'req-audit-malicious',
    urlOrigin: 'https://example.com',
    runId: 'run-audit-malicious',
    query: async () => ({
      ...validResult,
      lineage: {
        provider: 'password-hunter22',
        model: 'password-hunter22',
        skillDigest: 'password-hunter22',
        questionSetDigest: 'sha256:' + 'a'.repeat(64),
        stateDigest: 'sha256:' + 'b'.repeat(64),
        requestDigest: 'sha256:' + 'c'.repeat(64),
      },
    }),
    normalAgentDecision: {
      engine: 'normal-agent',
      operation: 'CLICK',
      targetRef: 'password-hunter22',
    },
    postcondition: {
      verified: true,
      method: 'password-hunter22',
    },
  });
  assert.equal(recAuditMalicious.lineage.provider, '[REDACTED]');
  assert.equal(recAuditMalicious.lineage.model, '[REDACTED]');
  assert.equal(recAuditMalicious.lineage.skillDigest, '[REDACTED]');
  assert.equal(recAuditMalicious.normalAgentDecision.targetRef, '[REDACTED]');
  assert.equal(recAuditMalicious.postcondition.method, '[REDACTED]');
  assert.equal(shadowEvidenceLine(recAuditMalicious).includes('hunter22'), false);

  // non-object lineage ⇒ null
  assert.equal(projectLineage(null), null);
  assert.equal(projectLineage('string'), null);
  assert.equal(projectLineage([1, 2, 3]), null);

  // direct sanitizeReasonCode
  assert.equal(sanitizeReasonCode('password-hunter22'), 'UNKNOWN');
  assert.equal(sanitizeReasonCode('VALID_CODE_123'), 'UNKNOWN');
  assert.equal(sanitizeReasonCode(''), 'UNKNOWN');
  assert.equal(sanitizeReasonCode(null), 'UNKNOWN');

  // query throw error.code='password-hunter22' ⇒ record.reason === 'QUERY_FAILED:UNKNOWN', evidence line sạch hunter22
  const recQueryFail = await runShadowBrowserStep({
    snapshot,
    goal: 'Click confirm',
    requestId: 'req-reason-bad',
    urlOrigin: 'https://example.com',
    runId: 'run-reason-bad',
    query: async () => {
      const err = new Error('simulated query failure');
      err.code = 'password-hunter22';
      throw err;
    },
  });
  assert.equal(recQueryFail.status, 'fallback-required');
  assert.equal(recQueryFail.reason, 'QUERY_FAILED:UNKNOWN');
  const lineQueryFail = shadowEvidenceLine(recQueryFail);
  assert.equal(lineQueryFail.includes('hunter22'), false);

  // build failure with bad error code
  const recBuildFail = await runShadowBrowserStep({
    snapshot: null,
    goal: 'Click confirm',
    requestId: 'req-build-fail',
    urlOrigin: 'https://example.com',
    runId: 'run-build-fail',
    query: async () => validResult,
  });
  assert.equal(recBuildFail.status, 'fallback-required');
  assert.equal(recBuildFail.reason, 'BUILD_FAILED:UNKNOWN');
  assert.equal(shadowEvidenceLine(recBuildFail).includes('hunter22'), false);

  // 6. Audit field còn lại: thêm assert record (trừ requestId/runId là id caller-controlled pattern-bounded)
  // không chứa hunter22 khi mọi input độc hại ở trên cùng lúc
  const allToxicRecord = await runShadowBrowserStep({
    snapshot,
    goal: 'Click confirm',
    requestId: 'req-all-toxic',
    urlOrigin: 'https://example.com',
    runId: 'run-all-toxic',
    query: async () => ({
      schema: 'webmcp-jev-result/1',
      requestId: 'req-all-toxic',
      status: 'ok',
      advisoryOnly: true,
      answers: {
        operation: {
          type: 'choice',
          choice: 'CLICK',
          probabilities: { CLICK: 1.0 },
          confidence: 0.95,
        },
        click_target: {
          type: 'choice',
          choice: 'r3',
          probabilities: { r3: 1.0 },
          confidence: 0.99,
        },
      },
      lineage: {
        provider: 'typesafe',
        model: 'password-hunter22',
        skillDigest: 'password-hunter22',
        questionSetDigest: 'password-hunter22',
        stateDigest: 'password-hunter22',
        requestDigest: 'password-hunter22',
        leakField: 'password-hunter22',
      },
    }),
    normalAgentDecision: {
      engine: 'password-hunter22',
      operation: 'password-hunter22',
      targetRef: 'password-hunter22',
      text: 'password-hunter22',
      values: ['password-hunter22'],
    },
    postcondition: {
      verified: true,
      method: 'password-hunter22',
      detail: 'password-hunter22',
      extra: 'password-hunter22',
    },
  });

  const recordCopy = { ...allToxicRecord, requestId: undefined, runId: undefined };
  assert.equal(JSON.stringify(recordCopy).includes('hunter22'), false);
  assert.equal(shadowEvidenceLine(allToxicRecord).includes('hunter22'), false);

  // Same audit when query fails with toxic error code
  const allToxicFailRecord = await runShadowBrowserStep({
    snapshot,
    goal: 'Click confirm',
    requestId: 'req-all-toxic-fail',
    urlOrigin: 'https://example.com',
    runId: 'run-all-toxic-fail',
    query: async () => {
      const err = new Error('password-hunter22');
      err.code = 'password-hunter22';
      throw err;
    },
    normalAgentDecision: {
      engine: 'password-hunter22',
      operation: 'password-hunter22',
      targetRef: 'password-hunter22',
      text: 'password-hunter22',
    },
    postcondition: {
      method: 'password-hunter22',
    },
  });
  const failRecordCopy = { ...allToxicFailRecord, requestId: undefined, runId: undefined };
  assert.equal(JSON.stringify(failRecordCopy).includes('hunter22'), false);
  assert.equal(shadowEvidenceLine(allToxicFailRecord).includes('hunter22'), false);
});

export const DOMAINS = {
  'schema': { const: 'webmcp-jev-shadow/1' },
  'kind': { const: 'browser-step' },
  'engine': { const: 'jev-shadow' },
  'shadow': { bool: true },
  'executed': { bool: true },
  'browserActions': { number: true },
  'status': { closed: ['ok', 'invalid', 'fallback-required'] },
  'reason': { reason: true, nullable: true },
  'requestId': { idPattern: true, extra: ['[REDACTED]'], nullable: true },
  'agreement': { bool: true, nullable: true },
  'snapshotDigest': { sha: true, nullable: true },
  'questionSetDigest': { sha: true, nullable: true },
  'snapshotCapturedAt': { number: true, nullable: true },
  'questionCount': { number: true },
  'createdAt': { iso: true, nullable: true },

  'jevDecision': { nullable: true },
  'jevDecision.operation': { closed: OPERATION_VALUES, extra: ['[REDACTED]'], nullable: true },
  'jevDecision.targetRef': { ref: true, extra: ['[REDACTED]'], nullable: true },
  'jevDecision.confidence': { numberRange: [0, 1], nullable: true },
  'jevDecision.snapshotDigest': { sha: true, nullable: true },
  'jevDecision.decidedAt': { number: true, nullable: true },
  'jevDecision.fingerprint': { sha: true, nullable: true },
  'jevDecision.valid': { bool: true },
  'jevDecision.invalid': { bool: true },
  'jevDecision.stale': { bool: true },
  'jevDecision.actionable': { bool: true },
  'jevDecision.reasons[*]': { closed: RESULT_REASONS },

  'normalAgentDecision': { nullable: true },
  'normalAgentDecision.engine': { closed: ENGINE_VALUES, extra: ['[REDACTED]'], nullable: true },
  'normalAgentDecision.operation': { closed: OPERATION_VALUES, extra: ['[REDACTED]'], nullable: true },
  'normalAgentDecision.targetRef': { ref: true, extra: ['[REDACTED]'], nullable: true },

  'postcondition': { nullable: true },
  'postcondition.verified': { bool: true, nullable: true },
  'postcondition.method': { closed: METHOD_VALUES, extra: ['[REDACTED]'], nullable: true },
  'postcondition.satisfied': { bool: true, nullable: true },

  'lineage': { nullable: true },
  'lineage.provider': { closed: ['typesafe', '[REDACTED]'], nullable: true },
  'lineage.model': { model: true, nullable: true },
  'lineage.skillDigest': { shaOrRedacted: true, nullable: true },
  'lineage.questionSetDigest': { shaOrRedacted: true, nullable: true },
  'lineage.stateDigest': { shaOrRedacted: true, nullable: true },
  'lineage.requestDigest': { shaOrRedacted: true, nullable: true },

  'timing.buildMs': { number: true },
  'timing.validateMs': { number: true },
  'timing.queryMs': { number: true },
  'timing.overheadMs': { number: true },
  'timing.totalMs': { number: true },

  'mcpCalls.shadow': { number: true },
  'mcpCalls.browserActions': { number: true },
};

export function walkRecordAndAssertDomains(record, domains = DOMAINS) {
  function walk(val, path) {
    if (val === null || typeof val !== 'object') {
      const domain = domains[path];
      assert.ok(domain, `Missing domain definition for path "${path}" with value ${JSON.stringify(val)}`);

      if (val === null) {
        assert.ok(domain.nullable, `Path "${path}" has null value but domain is not nullable`);
        return;
      }

      if (domain.idPattern) {
        assert.equal(typeof val, 'string', `Path "${path}" expected string id, got ${typeof val}`);
        if (domain.extra && domain.extra.includes(val)) return;
        assert.ok(/^[a-zA-Z0-9_-]+(@[a-zA-Z0-9_.-]+)?$/.test(val), `Path "${path}" id "${val}" does not match id pattern`);
        return;
      }

      if (domain.const !== undefined) {
        assert.equal(val, domain.const, `Path "${path}" expected const ${domain.const}, got ${val}`);
        return;
      }

      if (domain.bool) {
        assert.equal(typeof val, 'boolean', `Path "${path}" expected boolean, got ${typeof val} (${val})`);
        return;
      }

      if (domain.number) {
        assert.equal(typeof val, 'number', `Path "${path}" expected number, got ${typeof val} (${val})`);
        assert.ok(Number.isFinite(val), `Path "${path}" expected finite number, got ${val}`);
        return;
      }

      if (domain.numberRange) {
        assert.equal(typeof val, 'number', `Path "${path}" expected number, got ${typeof val} (${val})`);
        assert.ok(Number.isFinite(val), `Path "${path}" expected finite number, got ${val}`);
        const [min, max] = domain.numberRange;
        assert.ok(val >= min && val <= max, `Path "${path}" value ${val} outside range [${min}, ${max}]`);
        return;
      }

      if (domain.reason) {
        assert.equal(typeof val, 'string', `Path "${path}" expected string reason, got ${typeof val}`);
        if (val === 'INVALID_RESULT') return;
        const match = val.match(/^(BUILD_FAILED|QUERY_FAILED):([A-Z0-9_]+)$/);
        assert.ok(match, `Path "${path}" reason "${val}" does not match format (BUILD_FAILED|QUERY_FAILED):<CODE>`);
        const code = match[2];
        assert.ok(FAILURE_CODES.includes(code), `Path "${path}" failure code "${code}" is not in FAILURE_CODES`);
        return;
      }

      if (domain.ref) {
        assert.equal(typeof val, 'string', `Path "${path}" expected string ref, got ${typeof val}`);
        if (domain.extra && domain.extra.includes(val)) return;
        assert.ok(isClosedRef(val), `Path "${path}" ref "${val}" is not closed ref`);
        return;
      }

      if (domain.sha) {
        assert.equal(typeof val, 'string', `Path "${path}" expected string sha, got ${typeof val}`);
        assert.ok(/^sha256:[0-9a-f]{64}$/.test(val), `Path "${path}" sha "${val}" is not valid sha256`);
        return;
      }

      if (domain.shaOrRedacted) {
        assert.equal(typeof val, 'string', `Path "${path}" expected string sha/redacted, got ${typeof val}`);
        if (val === '[REDACTED]') return;
        assert.ok(/^sha256:[0-9a-f]{64}$/.test(val), `Path "${path}" sha "${val}" is not valid sha256`);
        return;
      }

      if (domain.model) {
        assert.equal(typeof val, 'string', `Path "${path}" expected string model, got ${typeof val}`);
        if (val === '[REDACTED]') return;
        assert.ok(/^jev-[0-9.]+$/.test(val), `Path "${path}" model "${val}" does not match LINEAGE_MODEL_PATTERN`);
        return;
      }

      if (domain.iso) {
        assert.equal(typeof val, 'string', `Path "${path}" expected ISO string, got ${typeof val}`);
        assert.ok(!isNaN(Date.parse(val)), `Path "${path}" ISO string "${val}" failed to parse`);
        return;
      }

      if (domain.closed) {
        const allowed = [...domain.closed, ...(domain.extra || [])];
        assert.ok(allowed.includes(val), `Path "${path}" value "${val}" not in closed set ${JSON.stringify(allowed)}`);
        return;
      }

      assert.fail(`Path "${path}" had unrecognized domain rule`);
      return;
    }

    if (Array.isArray(val)) {
      val.forEach((item) => walk(item, `${path}[*]`));
      return;
    }

    for (const [k, v] of Object.entries(val)) {
      const childPath = path ? `${path}.${k}` : k;
      walk(v, childPath);
    }
  }

  walk(record, '');
}

test('16. Sol L1 round 3: năm counterexample của Sol (closed vocabulary)', async () => {
  const baseSnapshot = '- ref=r1 button "Confirm"';
  const controlLineage = {
    provider: 'typesafe',
    model: 'jev-1.13.0',
    skillDigest: 'sha256:' + '0'.repeat(64),
    questionSetDigest: 'sha256:' + '1'.repeat(64),
    stateDigest: 'sha256:' + '2'.repeat(64),
    requestDigest: 'sha256:' + '3'.repeat(64),
  };

  // 1. operation.choice 'password-hunter22' ⇒ jevDecision.operation === '[REDACTED]'
  const rec1 = await runShadowBrowserStep({
    snapshot: baseSnapshot,
    goal: 'Click confirm',
    requestId: 'req-sol-ce-1',
    urlOrigin: 'https://example.com',
    runId: 'run-sol-1',
    query: async () => ({
      schema: 'webmcp-jev-result/1',
      requestId: 'req-sol-ce-1',
      status: 'ok',
      advisoryOnly: true,
      answers: {
        operation: {
          type: 'choice',
          choice: 'password-hunter22',
          probabilities: { 'password-hunter22': 1.0 },
          confidence: 0.95,
        },
      },
      lineage: controlLineage,
    }),
  });
  assert.equal(rec1.jevDecision.operation, '[REDACTED]');
  assert.equal(rec1.status, 'invalid');
  assert.equal(rec1.reason, 'INVALID_RESULT');
  assert.ok(rec1.jevDecision.reasons.includes('ANSWER_INVALID'));
  const line1 = shadowEvidenceLine(rec1);
  assert.equal(line1.includes('hunter22'), false);
  assert.equal(line1.includes('PASSWORDHUNTER22'), false);
  walkRecordAndAssertDomains(rec1, DOMAINS);

  // 2. click_target.choice 'password-hunter22' ⇒ jevDecision.targetRef === '[REDACTED]'
  const rec2 = await runShadowBrowserStep({
    snapshot: baseSnapshot,
    goal: 'Click confirm',
    requestId: 'req-sol-ce-2',
    urlOrigin: 'https://example.com',
    runId: 'run-sol-2',
    query: async () => ({
      schema: 'webmcp-jev-result/1',
      requestId: 'req-sol-ce-2',
      status: 'ok',
      advisoryOnly: true,
      answers: {
        operation: {
          type: 'choice',
          choice: 'CLICK',
          probabilities: { CLICK: 1.0 },
          confidence: 0.95,
        },
        click_target: {
          type: 'choice',
          choice: 'password-hunter22',
          probabilities: { 'password-hunter22': 1.0 },
          confidence: 0.95,
        },
      },
      lineage: controlLineage,
    }),
  });
  assert.equal(rec2.jevDecision.targetRef, '[REDACTED]');
  assert.equal(rec2.status, 'invalid');
  assert.equal(rec2.reason, 'INVALID_RESULT');
  assert.ok(rec2.jevDecision.reasons.includes('TARGET_MISSING'));
  const line2 = shadowEvidenceLine(rec2);
  assert.equal(line2.includes('hunter22'), false);
  assert.equal(line2.includes('PASSWORDHUNTER22'), false);
  walkRecordAndAssertDomains(rec2, DOMAINS);

  // 3. WAIT + confidence:'PASSWORDHUNTER22' ⇒ jevDecision.confidence === null
  const rec3 = await runShadowBrowserStep({
    snapshot: baseSnapshot,
    goal: 'Click confirm',
    requestId: 'req-sol-ce-3',
    urlOrigin: 'https://example.com',
    runId: 'run-sol-3',
    query: async () => ({
      schema: 'webmcp-jev-result/1',
      requestId: 'req-sol-ce-3',
      status: 'ok',
      advisoryOnly: true,
      answers: {
        operation: {
          type: 'choice',
          choice: 'WAIT',
          probabilities: { WAIT: 1.0 },
          confidence: 'PASSWORDHUNTER22',
        },
      },
      lineage: controlLineage,
    }),
  });
  assert.equal(rec3.jevDecision.confidence, null);
  const line3 = shadowEvidenceLine(rec3);
  assert.equal(line3.includes('hunter22'), false);
  assert.equal(line3.includes('PASSWORDHUNTER22'), false);
  walkRecordAndAssertDomains(rec3, DOMAINS);

  // 4. snapshot có - ref=password-hunter22 button "X" ⇒ normalize drop ref đó
  // (stats.droppedRefGrammar >= 1, element không xuất hiện); normalAgentDecision.targetRef:'password-hunter22' ⇒ '[REDACTED]'
  const toxicSnapText = '- ref=password-hunter22 button "X"\n- ref=r1 button "Confirm"';
  const norm4 = normalizeAriaSnapshot(toxicSnapText);
  assert.ok(norm4.stats.droppedRefGrammar >= 1);
  assert.equal(norm4.elements.some((el) => el.ref === 'password-hunter22'), false);

  const rec4 = await runShadowBrowserStep({
    snapshot: toxicSnapText,
    goal: 'Click confirm',
    requestId: 'req-sol-ce-4',
    urlOrigin: 'https://example.com',
    runId: 'run-sol-4',
    query: async () => ({
      schema: 'webmcp-jev-result/1',
      requestId: 'req-sol-ce-4',
      status: 'ok',
      advisoryOnly: true,
      answers: {
        operation: {
          type: 'choice',
          choice: 'CLICK',
          probabilities: { CLICK: 1.0 },
          confidence: 0.95,
        },
        click_target: {
          type: 'choice',
          choice: 'r1',
          probabilities: { r1: 1.0 },
          confidence: 0.95,
        },
      },
      lineage: controlLineage,
    }),
    normalAgentDecision: {
      engine: 'normal-agent',
      operation: 'CLICK',
      targetRef: 'password-hunter22',
    },
  });
  assert.equal(rec4.normalAgentDecision.targetRef, '[REDACTED]');
  const line4 = shadowEvidenceLine(rec4);
  assert.equal(line4.includes('hunter22'), false);
  assert.equal(line4.includes('PASSWORDHUNTER22'), false);
  walkRecordAndAssertDomains(rec4, DOMAINS);

  // 5. query throw error.code='PASSWORDHUNTER22' ⇒ reason === 'QUERY_FAILED:UNKNOWN'
  const rec5 = await runShadowBrowserStep({
    snapshot: baseSnapshot,
    goal: 'Click confirm',
    requestId: 'req-sol-ce-5',
    urlOrigin: 'https://example.com',
    runId: 'run-sol-5',
    query: async () => {
      const err = new Error('simulated failure');
      err.code = 'PASSWORDHUNTER22';
      throw err;
    },
  });
  assert.equal(rec5.status, 'fallback-required');
  assert.equal(rec5.reason, 'QUERY_FAILED:UNKNOWN');
  const line5 = shadowEvidenceLine(rec5);
  assert.equal(line5.includes('hunter22'), false);
  assert.equal(line5.includes('PASSWORDHUNTER22'), false);
  walkRecordAndAssertDomains(rec5, DOMAINS);

  // Enum đóng cho sanitizeReasonCode & sanitizeResultReason
  assert.equal(sanitizeReasonCode('PASSWORDHUNTER22'), 'UNKNOWN');
  assert.equal(sanitizeReasonCode('VALID_CODE_123'), 'UNKNOWN');
  assert.equal(sanitizeReasonCode('JEV_RATE_LIMITED'), 'JEV_RATE_LIMITED');
  assert.equal(sanitizeResultReason('PASSWORDHUNTER22'), 'UNKNOWN');
  assert.equal(sanitizeResultReason('TARGET_MISSING'), 'TARGET_MISSING');
});

test('17. Sol L1 round 3: fuzz toàn record (schema-path, không theo content)', async () => {
  const HOSTILE_STRINGS = [
    'password-hunter22',
    'PASSWORDHUNTER22',
    'ｐａｓｓｗｏｒｄ',
    'pass\u200bword',
    'Password: hunter22',
    '482913',
    'token=abc',
    'eyJhbGciOiJIUzI1NiJ9.x.y',
    'ĐĂNG NHẬP',
    '__proto__',
  ];

  const baseSnapshot = '- ref=r1 button "Confirm"';
  const controlLineage = {
    provider: 'typesafe',
    model: 'jev-1.13.0',
    skillDigest: 'sha256:' + '0'.repeat(64),
    questionSetDigest: 'sha256:' + '1'.repeat(64),
    stateDigest: 'sha256:' + '2'.repeat(64),
    requestDigest: 'sha256:' + '3'.repeat(64),
  };

  const validResult = {
    schema: 'webmcp-jev-result/1',
    requestId: 'req-fuzz',
    status: 'ok',
    advisoryOnly: true,
    answers: {
      operation: {
        type: 'choice',
        choice: 'CLICK',
        probabilities: { CLICK: 1.0 },
        confidence: 0.95,
      },
      click_target: {
        type: 'choice',
        choice: 'r1',
        probabilities: { r1: 1.0 },
        confidence: 0.95,
      },
    },
    lineage: controlLineage,
  };

  for (const hostile of HOSTILE_STRINGS) {
    // 1. operation.choice
    const recOp = await runShadowBrowserStep({
      snapshot: baseSnapshot,
      goal: 'Click confirm',
      requestId: 'req-fuzz-op',
      urlOrigin: 'https://example.com',
      runId: 'run-fuzz',
      query: async () => ({
        ...validResult,
        requestId: 'req-fuzz-op',
        answers: {
          operation: {
            type: 'choice',
            choice: hostile,
            probabilities: { [hostile]: 1.0 },
            confidence: 0.9,
          },
        },
      }),
    });
    assert.equal(recOp.jevDecision.operation, '[REDACTED]');
    walkRecordAndAssertDomains(recOp, DOMAINS);
    assert.equal(shadowEvidenceLine(recOp).includes(hostile), false, `Evidence line must not contain hostile string "${hostile}" at operation.choice`);

    // 2. click_target.choice
    const recTarget = await runShadowBrowserStep({
      snapshot: baseSnapshot,
      goal: 'Click confirm',
      requestId: 'req-fuzz-target',
      urlOrigin: 'https://example.com',
      runId: 'run-fuzz',
      query: async () => ({
        ...validResult,
        requestId: 'req-fuzz-target',
        answers: {
          operation: {
            type: 'choice',
            choice: 'CLICK',
            probabilities: { CLICK: 1.0 },
            confidence: 0.9,
          },
          click_target: {
            type: 'choice',
            choice: hostile,
            probabilities: { [hostile]: 1.0 },
            confidence: 0.9,
          },
        },
      }),
    });
    assert.equal(recTarget.jevDecision.targetRef, '[REDACTED]');
    walkRecordAndAssertDomains(recTarget, DOMAINS);
    assert.equal(shadowEvidenceLine(recTarget).includes(hostile), false, `Evidence line must not contain hostile string "${hostile}" at click_target.choice`);

    // 3. confidence
    const recConf = await runShadowBrowserStep({
      snapshot: baseSnapshot,
      goal: 'Click confirm',
      requestId: 'req-fuzz-conf',
      urlOrigin: 'https://example.com',
      runId: 'run-fuzz',
      query: async () => ({
        ...validResult,
        requestId: 'req-fuzz-conf',
        answers: {
          operation: {
            type: 'choice',
            choice: 'WAIT',
            probabilities: { WAIT: 1.0 },
            confidence: hostile,
          },
        },
      }),
    });
    assert.equal(recConf.jevDecision.confidence, null);
    walkRecordAndAssertDomains(recConf, DOMAINS);
    assert.equal(shadowEvidenceLine(recConf).includes(hostile), false, `Evidence line must not contain hostile string "${hostile}" at confidence`);

    // 4. error code
    const recErr = await runShadowBrowserStep({
      snapshot: baseSnapshot,
      goal: 'Click confirm',
      requestId: 'req-fuzz-err',
      urlOrigin: 'https://example.com',
      runId: 'run-fuzz',
      query: async () => {
        const err = new Error('simulated query failure');
        err.code = hostile;
        throw err;
      },
    });
    assert.equal(recErr.reason, 'QUERY_FAILED:UNKNOWN');
    walkRecordAndAssertDomains(recErr, DOMAINS);
    assert.equal(shadowEvidenceLine(recErr).includes(hostile), false, `Evidence line must not contain hostile string "${hostile}" at error code`);

    // 5. normalAgentDecision.engine
    const recEngine = await runShadowBrowserStep({
      snapshot: baseSnapshot,
      goal: 'Click confirm',
      requestId: 'req-fuzz-engine',
      urlOrigin: 'https://example.com',
      runId: 'run-fuzz',
      query: async () => ({ ...validResult, requestId: 'req-fuzz-engine' }),
      normalAgentDecision: {
        engine: hostile,
        operation: 'CLICK',
        targetRef: 'r1',
      },
    });
    assert.equal(recEngine.normalAgentDecision.engine, '[REDACTED]');
    walkRecordAndAssertDomains(recEngine, DOMAINS);
    assert.equal(shadowEvidenceLine(recEngine).includes(hostile), false, `Evidence line must not contain hostile string "${hostile}" at normalAgentDecision.engine`);

    // 6. normalAgentDecision.operation
    const recNormOp = await runShadowBrowserStep({
      snapshot: baseSnapshot,
      goal: 'Click confirm',
      requestId: 'req-fuzz-norm-op',
      urlOrigin: 'https://example.com',
      runId: 'run-fuzz',
      query: async () => ({ ...validResult, requestId: 'req-fuzz-norm-op' }),
      normalAgentDecision: {
        engine: 'normal-agent',
        operation: hostile,
        targetRef: 'r1',
      },
    });
    assert.equal(recNormOp.normalAgentDecision.operation, '[REDACTED]');
    walkRecordAndAssertDomains(recNormOp, DOMAINS);
    assert.equal(shadowEvidenceLine(recNormOp).includes(hostile), false, `Evidence line must not contain hostile string "${hostile}" at normalAgentDecision.operation`);

    // 7. normalAgentDecision.targetRef
    const recNormTarget = await runShadowBrowserStep({
      snapshot: baseSnapshot,
      goal: 'Click confirm',
      requestId: 'req-fuzz-norm-target',
      urlOrigin: 'https://example.com',
      runId: 'run-fuzz',
      query: async () => ({ ...validResult, requestId: 'req-fuzz-norm-target' }),
      normalAgentDecision: {
        engine: 'normal-agent',
        operation: 'CLICK',
        targetRef: hostile,
      },
    });
    assert.equal(recNormTarget.normalAgentDecision.targetRef, '[REDACTED]');
    walkRecordAndAssertDomains(recNormTarget, DOMAINS);
    assert.equal(shadowEvidenceLine(recNormTarget).includes(hostile), false, `Evidence line must not contain hostile string "${hostile}" at normalAgentDecision.targetRef`);

    // 8. postcondition.method
    const recPost = await runShadowBrowserStep({
      snapshot: baseSnapshot,
      goal: 'Click confirm',
      requestId: 'req-fuzz-post',
      urlOrigin: 'https://example.com',
      runId: 'run-fuzz',
      query: async () => ({ ...validResult, requestId: 'req-fuzz-post' }),
      postcondition: {
        verified: true,
        method: hostile,
        satisfied: true,
      },
    });
    assert.equal(recPost.postcondition.method, '[REDACTED]');
    walkRecordAndAssertDomains(recPost, DOMAINS);
    assert.equal(shadowEvidenceLine(recPost).includes(hostile), false, `Evidence line must not contain hostile string "${hostile}" at postcondition.method`);

    // 9. lineage.provider
    const recProv = await runShadowBrowserStep({
      snapshot: baseSnapshot,
      goal: 'Click confirm',
      requestId: 'req-fuzz-prov',
      urlOrigin: 'https://example.com',
      runId: 'run-fuzz',
      query: async () => ({
        ...validResult,
        requestId: 'req-fuzz-prov',
        lineage: {
          ...controlLineage,
          provider: hostile,
        },
      }),
    });
    assert.equal(recProv.lineage.provider, '[REDACTED]');
    walkRecordAndAssertDomains(recProv, DOMAINS);
    assert.equal(shadowEvidenceLine(recProv).includes(hostile), false, `Evidence line must not contain hostile string "${hostile}" at lineage.provider`);

    // 10. lineage.model
    const recModel = await runShadowBrowserStep({
      snapshot: baseSnapshot,
      goal: 'Click confirm',
      requestId: 'req-fuzz-model',
      urlOrigin: 'https://example.com',
      runId: 'run-fuzz',
      query: async () => ({
        ...validResult,
        requestId: 'req-fuzz-model',
        lineage: {
          ...controlLineage,
          model: hostile,
        },
      }),
    });
    assert.equal(recModel.lineage.model, '[REDACTED]');
    walkRecordAndAssertDomains(recModel, DOMAINS);
    assert.equal(shadowEvidenceLine(recModel).includes(hostile), false, `Evidence line must not contain hostile string "${hostile}" at lineage.model`);

    // 11. lineage.skillDigest
    const recSkill = await runShadowBrowserStep({
      snapshot: baseSnapshot,
      goal: 'Click confirm',
      requestId: 'req-fuzz-skill',
      urlOrigin: 'https://example.com',
      runId: 'run-fuzz',
      query: async () => ({
        ...validResult,
        requestId: 'req-fuzz-skill',
        lineage: {
          ...controlLineage,
          skillDigest: hostile,
        },
      }),
    });
    assert.equal(recSkill.lineage.skillDigest, '[REDACTED]');
    walkRecordAndAssertDomains(recSkill, DOMAINS);
    assert.equal(shadowEvidenceLine(recSkill).includes(hostile), false, `Evidence line must not contain hostile string "${hostile}" at lineage.skillDigest`);

    // 12. ref của một element trong snapshot (ca riêng)
    const snapHostile = `- ref=${hostile} button "Toxic Button"\n- ref=r1 button "Confirm"`;
    const normSnap = normalizeAriaSnapshot(snapHostile);
    assert.ok(normSnap.stats.droppedRefGrammar >= 1);
    assert.equal(normSnap.elements.some((el) => el.ref === hostile), false);

    const recSnap = await runShadowBrowserStep({
      snapshot: snapHostile,
      goal: 'Click confirm',
      requestId: 'req-fuzz-snap',
      urlOrigin: 'https://example.com',
      runId: 'run-fuzz',
      query: async () => ({ ...validResult, requestId: 'req-fuzz-snap' }),
      normalAgentDecision: {
        engine: 'normal-agent',
        operation: 'CLICK',
        targetRef: hostile,
      },
    });
    assert.equal(recSnap.normalAgentDecision.targetRef, '[REDACTED]');
    walkRecordAndAssertDomains(recSnap, DOMAINS);
    assert.equal(shadowEvidenceLine(recSnap).includes(hostile), false, `Evidence line must not contain hostile string "${hostile}" at snapshot ref`);

    // 13. requestId (hostile string into requestId)
    const hostileReqId = `${hostile}!`;
    const recReq = await runShadowBrowserStep({
      snapshot: baseSnapshot,
      goal: 'Click confirm',
      requestId: hostileReqId,
      urlOrigin: 'https://example.com',
      runId: 'run-fuzz',
      query: async () => ({ ...validResult, requestId: hostileReqId }),
    });
    assert.equal(recReq.requestId, '[REDACTED]');
    walkRecordAndAssertDomains(recReq, DOMAINS);
    assert.equal(shadowEvidenceLine(recReq).includes(hostile), false, `Evidence line must not contain hostile string "${hostile}" at requestId`);

    if (!REQUEST_ID_PATTERN.test(hostile)) {
      const recRawReq = await runShadowBrowserStep({
        snapshot: baseSnapshot,
        goal: 'Click confirm',
        requestId: hostile,
        urlOrigin: 'https://example.com',
        runId: 'run-fuzz',
        query: async () => ({ ...validResult, requestId: hostile }),
      });
      assert.equal(recRawReq.requestId, '[REDACTED]');
      walkRecordAndAssertDomains(recRawReq, DOMAINS);
      assert.equal(shadowEvidenceLine(recRawReq).includes(hostile), false, `Evidence line must not contain hostile string "${hostile}" at raw requestId`);
    }
  }
});

test('18. Sol L1 round 4: build-failure requestId thuộc ID domain hoặc [REDACTED]', async () => {
  const baseSnapshot = '- ref=r1 button "Confirm"';
  const controlLineage = {
    provider: 'typesafe',
    model: 'jev-1.13.0',
    skillDigest: 'sha256:' + '0'.repeat(64),
    questionSetDigest: 'sha256:' + '1'.repeat(64),
    stateDigest: 'sha256:' + '2'.repeat(64),
    requestDigest: 'sha256:' + '3'.repeat(64),
  };

  // Helper unit tests
  assert.equal(closedRequestId('run_123@step-7'), 'run_123@step-7');
  assert.equal(closedRequestId('password-hunter22!'), '[REDACTED]');
  assert.equal(closedRequestId('PASSWORDHUNTER22!'), '[REDACTED]');
  assert.equal(closedRequestId(null), null);
  assert.equal(closedRequestId(undefined), null);
  assert.equal(closedRequestId(''), '[REDACTED]');
  assert.equal(closedRequestId(123), '[REDACTED]');

  // 1. requestId: 'password-hunter22!' ⇒ record build-failure requestId === '[REDACTED]', reason === 'BUILD_FAILED:UNKNOWN', shadowEvidenceLine(record) không chứa hunter22
  const rec1 = await runShadowBrowserStep({
    snapshot: baseSnapshot,
    goal: 'Click confirm',
    requestId: 'password-hunter22!',
    urlOrigin: 'https://example.com',
    runId: 'run-sol-r4-1',
    query: async () => ({}),
  });
  assert.equal(rec1.status, 'fallback-required');
  assert.equal(rec1.requestId, '[REDACTED]');
  assert.equal(rec1.reason, 'BUILD_FAILED:UNKNOWN');
  assert.equal(shadowEvidenceLine(rec1).includes('hunter22'), false);
  walkRecordAndAssertDomains(rec1, DOMAINS);

  // 2. requestId: 'PASSWORDHUNTER22!' ⇒ record build-failure requestId === '[REDACTED]', reason === 'BUILD_FAILED:UNKNOWN', shadowEvidenceLine(record) không chứa PASSWORDHUNTER22
  const rec2 = await runShadowBrowserStep({
    snapshot: baseSnapshot,
    goal: 'Click confirm',
    requestId: 'PASSWORDHUNTER22!',
    urlOrigin: 'https://example.com',
    runId: 'run-sol-r4-2',
    query: async () => ({}),
  });
  assert.equal(rec2.status, 'fallback-required');
  assert.equal(rec2.requestId, '[REDACTED]');
  assert.equal(rec2.reason, 'BUILD_FAILED:UNKNOWN');
  assert.equal(shadowEvidenceLine(rec2).includes('PASSWORDHUNTER22'), false);
  walkRecordAndAssertDomains(rec2, DOMAINS);

  // 3. Control: requestId: 'run_123@step-7' ⇒ record requestId === 'run_123@step-7' (pass-through, status ok)
  const recControl = await runShadowBrowserStep({
    snapshot: baseSnapshot,
    goal: 'Click confirm',
    requestId: 'run_123@step-7',
    urlOrigin: 'https://example.com',
    runId: 'run-sol-r4-ctrl',
    query: async () => ({
      schema: 'webmcp-jev-result/1',
      requestId: 'run_123@step-7',
      status: 'ok',
      advisoryOnly: true,
      answers: {
        operation: {
          type: 'choice',
          choice: 'CLICK',
          probabilities: { CLICK: 0.9, WAIT: 0.05, DONE: 0.03, BLOCKED: 0.02 },
          confidence: 0.95,
        },
        click_target: {
          type: 'choice',
          choice: 'r1',
          probabilities: { r1: 1.0 },
          confidence: 0.99,
        },
      },
      lineage: controlLineage,
    }),
  });
  assert.equal(recControl.status, 'ok');
  assert.equal(recControl.requestId, 'run_123@step-7');
  walkRecordAndAssertDomains(recControl, DOMAINS);
});




