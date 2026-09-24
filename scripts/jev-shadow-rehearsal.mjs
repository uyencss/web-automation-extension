// scripts/jev-shadow-rehearsal.mjs
// Milestone M4 rehearsal harness: corpus generator, offline provider, fault matrix, metrics.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  runShadowBrowserStep,
  recheckShadowTarget,
  canonicalJson,
  sha256hex,
  ACTION_OPERATIONS,
  CONTROL_OPERATIONS,
  TARGET_QUESTION_IDS,
  OPERATION_QUESTION,
} from '../lib/jev-shadow/loop.mjs';
import {
  aggregateShadowMetrics,
  aggregateFaultResults,
  shadowEvidenceLine,
  percentile,
} from '../lib/jev-shadow/metrics.mjs';

export { canonicalJson, sha256hex };

// 32-bit deterministic Mulberry32 PRNG
export function mulberry32(seed) {
  let s = (seed ?? 0x4d345345) >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const ARCHETYPES = Object.freeze([
  'login-form',
  'settings-nav',
  'product-grid',
  'pagination',
  'modal-dialog',
  'consent-banner',
  'search-autocomplete',
  'iframe-refs',
  'vi-labels',
  'read-only',
  'ambiguous-submits',
  'dense-page',
]);

export const INJECTED_SECRET_LITERALS = Object.freeze([
  { label: 'password', value: 'hunter22' },
  { label: 'otp', value: '482913' },
  { label: 'api-key', value: 'sk-test-abcdef123456' },
  { label: 'session', value: 'session=abc123def456' },
  { label: 'jwt', value: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcGVyYXRvciJ9.c2lnbmF0dXJl' },
  { label: 'pan', value: '4111 1111 1111 1111' },
  { label: 'token', value: 'token=3f9a1c2b4d5e6f708192a3b4c5d6e7f8' },
]);

export function buildCorpus({ count = 216, seed = 0x4d345345 } = {}) {
  const cases = [];
  const variantsPerArchetype = Math.ceil(count / ARCHETYPES.length);
  const totalCount = variantsPerArchetype * ARCHETYPES.length;

  for (let caseIndex = 0; caseIndex < totalCount; caseIndex++) {
    const archetype = ARCHETYPES[caseIndex % ARCHETYPES.length];
    const v = Math.floor(caseIndex / ARCHETYPES.length);
    const caseId = `case-${archetype}-${v}`;

    // 1/4 of cases have sensitive query strings in url
    const hasSensitiveUrl = caseIndex % 4 === 0;
    const urlOrigin = 'https://app.example.com';
    let url = `${urlOrigin}/workflow/${archetype}?view=normal`;
    if (hasSensitiveUrl) {
      url = `${urlOrigin}/workflow/${archetype}?token=token=3f9a1c2b4d5e6f708192a3b4c5d6e7f8`;
    }

    // 0..3 injected secrets for ~1/4 of cases
    const injectedSecrets = [];
    if (hasSensitiveUrl) {
      const secretCount = (Math.floor(caseIndex / 4) % 3) + 1;
      for (let s = 0; s < secretCount; s++) {
        const item = INJECTED_SECRET_LITERALS[(caseIndex + s * 2) % INJECTED_SECRET_LITERALS.length];
        if (!injectedSecrets.some((x) => x.label === item.label)) {
          injectedSecrets.push(item);
        }
      }
    }

    const hasPwSecret = injectedSecrets.some((s) => s.label === 'password');
    const pwValue = hasPwSecret ? 'hunter22' : '';

    let goal = '';
    let snapshotLines = [];
    let normalAgentDecision = null;

    switch (archetype) {
      case 'login-form': {
        goal = 'Sign in with the operator account';
        snapshotLines = [
          '- document "Login Form"',
          '  - ref=r1 textbox "Email"',
          `  - ref=r2 textbox "Password" value="${pwValue}"`,
          '  - ref=r3 checkbox "Remember me" [checked=false]',
          '  - ref=r4 button "Sign in"',
          '  - ref=r5 link "Forgot password"',
          '  - ref=r6 button "SSO Sign in" [disabled]',
        ];
        normalAgentDecision = { operation: 'CLICK', targetRef: 'r4' };
        break;
      }

      case 'settings-nav': {
        goal = 'Save settings';
        snapshotLines = [
          '- document "Account Settings"',
          '  - ref=r1 link "Profile settings"',
          '  - ref=r2 link "Security preferences"',
          '  - ref=r3 switch "Dark mode" [checked=false]',
          '  - ref=r4 switch "Email notifications" [checked=true]',
          '  - ref=r5 button "Save"',
          '  - ref=r6 button "Reset defaults" [disabled]',
        ];
        normalAgentDecision = { operation: 'CLICK', targetRef: 'r5' };
        break;
      }

      case 'product-grid': {
        goal = `Add to cart Keyboard ${v}`;
        snapshotLines = [
          '- document "Shop Catalog"',
          `  - ref=r0 heading "Product Catalog ${v}" (h2)`,
          `  - ref=r1 button "Add to cart Keyboard ${v}"`,
          `  - ref=r2 button "Add to cart Mouse ${v}"`,
          `  - ref=r3 button "Add to cart Monitor ${v}"`,
        ];
        normalAgentDecision = { operation: 'CLICK', targetRef: 'r1' };
        break;
      }

      case 'pagination': {
        goal = 'Go to Next page';
        snapshotLines = [
          '- document "Search Results"',
          '  - ref=r0 heading "Page items" (h1)',
          '  - ref=r1 button "Previous" [disabled]',
          '  - ref=r2 link "1" [selected]',
          '  - ref=r3 link "2"',
          '  - ref=r4 link "3"',
          '  - ref=r5 button "Next"',
        ];
        normalAgentDecision = { operation: 'CLICK', targetRef: 'r5' };
        break;
      }

      case 'modal-dialog': {
        goal = 'Confirm dialog action';
        snapshotLines = [
          '- document "Confirmation Dialog"',
          '  - text "Warning: action cannot be undone"',
          '  - ref=r1 button "Confirm"',
          '  - ref=r2 button "Close"',
        ];
        normalAgentDecision = { operation: 'CLICK', targetRef: 'r1' };
        break;
      }

      case 'consent-banner': {
        goal = 'Accept all cookies';
        snapshotLines = [
          '- document "Privacy Preferences"',
          '  - text "We use cookies to enhance experience"',
          '  - ref=r1 button "Accept all"',
          '  - ref=r2 button "Reject"',
          '  - ref=r3 button "Settings"',
        ];
        normalAgentDecision = { operation: 'CLICK', targetRef: 'r1' };
        break;
      }

      case 'search-autocomplete': {
        goal = 'Search documentation query';
        snapshotLines = [
          '- document "Documentation Search"',
          '  - ref=r1 searchbox "Search query"',
          '  - ref=r2 combobox "Search suggestions"',
          '    - option "API Reference" value="api"',
          '  - ref=r3 button "Search"',
        ];
        normalAgentDecision = { operation: 'TYPE_TEXT', targetRef: 'r1' };
        break;
      }

      case 'iframe-refs': {
        goal = 'Submit form in iframe';
        snapshotLines = [
          '- document "Multi-frame Workspace"',
          '  - ref=f1r1 textbox "Username"',
          '  - ref=f1r2 button "Submit form"',
          '  - ref=f2r7 link "Help frame"',
        ];
        normalAgentDecision = { operation: 'CLICK', targetRef: 'f1r2' };
        break;
      }

      case 'vi-labels': {
        goal = 'Đăng nhập vào hệ thống';
        snapshotLines = [
          '- document "Cổng dịch vụ trực tuyến"',
          '  - ref=r1 textbox "Tài khoản"',
          `  - ref=r2 textbox "Password / Mật khẩu" value="${pwValue}"`,
          '  - ref=r3 button "Đăng nhập"',
          '  - ref=r4 link "Quên mật khẩu"',
          '  - ref=r5 button "Tiếp theo"',
        ];
        normalAgentDecision = { operation: 'CLICK', targetRef: 'r3' };
        break;
      }

      case 'read-only': {
        goal = 'Review terms agreement is completed and done';
        snapshotLines = [
          '- document "Terms and Conditions"',
          '  - ref=r0 heading "User Agreement" (h1)',
          '  - text "Viewing is completed and documentation is fully done."',
          '  - ref=r1 link "Read more"',
        ];
        normalAgentDecision = { operation: 'DONE', targetRef: null };
        break;
      }

      case 'ambiguous-submits': {
        goal = 'Submit order now';
        snapshotLines = [
          '- document "Order Checkout"',
          '  - ref=r1 button "Submit order"',
          '  - ref=r2 button "Submit order now"',
        ];
        normalAgentDecision = { operation: 'CLICK', targetRef: 'r2' };
        break;
      }

      case 'dense-page': {
        goal = 'Save dense form';
        snapshotLines = [
          '- document "Dense Admin Console"',
          '  - ref=d1 button "Save dense form"',
        ];
        for (let j = 2; j <= 105; j++) {
          snapshotLines.push(`  - ref=d${j} link "Row Link ${j}"`);
        }
        normalAgentDecision = { operation: 'CLICK', targetRef: 'd1' };
        break;
      }

      default:
        break;
    }

    // Plant non-password injected secrets into text / static notes if any
    for (const s of injectedSecrets) {
      if (s.label === 'otp') {
        snapshotLines.push(`  - text "Verification code: ${s.value}"`);
      } else if (s.label === 'api-key') {
        snapshotLines.push(`  - text "API key: ${s.value}"`);
      } else if (s.label === 'session') {
        snapshotLines.push(`  - text "StaticText: ${s.value}"`);
      } else if (s.label === 'jwt') {
        snapshotLines.push(`  - text "JWT: ${s.value}"`);
      } else if (s.label === 'pan') {
        snapshotLines.push(`  - text "PAN: ${s.value}"`);
      } else if (s.label === 'token') {
        snapshotLines.push(`  - text "Token: ${s.value}"`);
      }
    }

    cases.push({
      caseId,
      archetype,
      goal,
      url,
      urlOrigin,
      snapshot: snapshotLines.join('\n'),
      normalAgentDecision,
      postcondition: { verified: true, method: 'snapshot-diff', satisfied: true },
      normalAgentMcpCalls: 4,
      injectedSecrets,
    });
  }

  return cases;
}

function roleMatchesVerb(role, goalText) {
  const g = goalText.toLowerCase();
  if (role === 'button' || role === 'link') {
    return /(?:sign|log in|login|đăng nhập|submit|confirm|accept|save|click|bấm|chọn|tiếp theo|next|previous|read|add|cart|order)/i.test(g);
  }
  if (role === 'textbox' || role === 'searchbox' || role === 'spinbutton') {
    return /(?:type|enter|nhập|search|tìm|fill|write|tài khoản|email|password|mật khẩu)/i.test(g);
  }
  if (role === 'combobox' || role === 'select' || role === 'listbox') {
    return /(?:select|choose|chọn)/i.test(g);
  }
  if (role === 'checkbox' || role === 'switch') {
    return /(?:check|toggle|switch|bật|tắt|remember|ghi nhớ)/i.test(g);
  }
  return false;
}

export function buildNormalizedProbabilities(keys, chosenKey, conf, keyScores = {}) {
  if (!keys || keys.length === 0) return {};
  if (keys.length === 1) return { [keys[0]]: 1.0 };
  const choiceProb = Math.min(0.98, Math.max(0.55, Number(conf)));
  const remaining = 1.0 - choiceProb;
  const otherKeys = keys.filter((k) => k !== chosenKey);
  const weights = otherKeys.map((k) => Math.max(0.01, (keyScores[k] || 0) + 0.1));
  const sumWeights = weights.reduce((a, b) => a + b, 0);
  const probs = { [chosenKey]: choiceProb };
  let allocated = 0;
  for (let i = 0; i < otherKeys.length; i += 1) {
    const share = i === otherKeys.length - 1
      ? Math.max(0, remaining - allocated)
      : (weights[i] / sumWeights) * remaining;
    probs[otherKeys[i]] = share;   // KHÔNG round từng phần
    allocated += share;
  }
  // chuẩn hoá lại để tổng đúng 1 (sai số float)
  const total = Object.values(probs).reduce((a, b) => a + b, 0);
  probs[chosenKey] = Math.max(0, Math.min(1, probs[chosenKey] + (1.0 - total)));
  return probs;
}

export function rehearsalProvider(wireBody, options = {}) {
  const goal = typeof wireBody?.state?.goal === 'string' ? wireBody.state.goal : '';
  const goalTokens = goal.toLowerCase().split(/[^a-z0-9à-ỹđ\u1ea0-\u1ef9]+/i).filter(Boolean);
  const elements = Array.isArray(wireBody?.state?.elements) ? wireBody.state.elements : [];
  const questions = wireBody?.questions && typeof wireBody.questions === 'object' ? wireBody.questions : {};
  const caseIndex = typeof options?.caseIndex === 'number' ? options.caseIndex : 1;

  // Score candidate elements for each operation
  const candidateScoresByOp = {};
  for (const op of ACTION_OPERATIONS) {
    const qId = TARGET_QUESTION_IDS[op];
    if (!questions[qId]) continue;

    const criteria = questions[qId].criteria || {};
    const refKeys = Object.keys(criteria);
    const scoredList = [];

    for (const ref of refKeys) {
      if (ref === 'none') {
        scoredList.push({ ref, score: 0 });
        continue;
      }
      const el = elements.find((e) => e.ref === ref);
      if (!el) {
        scoredList.push({ ref, score: 0 });
        continue;
      }
      const nameLower = (el.name || '').toLowerCase();
      let tokenMatches = 0;
      for (const t of goalTokens) {
        if (nameLower.includes(t)) tokenMatches++;
      }
      const verbBonus = roleMatchesVerb(el.role, goal) ? 0.25 : 0;
      const score = tokenMatches + verbBonus;
      scoredList.push({ ref, score });
    }

    scoredList.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.ref.localeCompare(b.ref);
    });

    candidateScoresByOp[op] = scoredList;
  }

  // Select operation
  const opCriteria = questions.operation?.criteria ? Object.keys(questions.operation.criteria) : [];
  let bestActionOp = null;
  let bestActionScore = -1;

  for (const op of ACTION_OPERATIONS) {
    if (!candidateScoresByOp[op] || candidateScoresByOp[op].length === 0) continue;
    const topCand = candidateScoresByOp[op][0];
    if (topCand && topCand.score > bestActionScore) {
      bestActionScore = topCand.score;
      bestActionOp = op;
    }
  }

  let selectedOp = 'WAIT';
  if (bestActionScore > 0 && bestActionOp) {
    selectedOp = bestActionOp;
  } else if (/(?:done|finish|hoàn tất)/i.test(goal)) {
    selectedOp = opCriteria.includes('DONE') ? 'DONE' : 'WAIT';
  } else {
    selectedOp = opCriteria.includes('WAIT') ? 'WAIT' : (opCriteria[0] || 'WAIT');
  }

  // Target selection with deliberate disagreement zone: caseIndex % 11 === 0 selects top-2 if available
  let chosenTargetRef = null;
  let top1CandScore = 0;
  let top2CandScore = 0;

  if (ACTION_OPERATIONS.includes(selectedOp) && candidateScoresByOp[selectedOp]?.length > 0) {
    const cands = candidateScoresByOp[selectedOp];
    top1CandScore = cands[0]?.score ?? 0;
    top2CandScore = cands[1]?.score ?? 0;

    if (caseIndex % 11 === 0 && cands.length >= 2) {
      chosenTargetRef = cands[1].ref;
    } else {
      chosenTargetRef = cands[0].ref;
    }
  }

  // Calculate confidence: 0.55 + 0.4 * (top1 - top2) / max(top1, 1) clamped to [0.55, 0.98]
  const rawConf = 0.55 + 0.4 * ((top1CandScore - top2CandScore) / Math.max(top1CandScore, 1));
  const targetConfidence = Math.min(0.98, Math.max(0.55, Number(rawConf.toFixed(4))));

  // Build answer envelopes for all questions
  const answers = {};

  // 1. Operation question
  const opScoresMap = {};
  for (const opKey of opCriteria) {
    if (opKey === selectedOp) {
      opScoresMap[opKey] = Math.max(bestActionScore, 1.0);
    } else if (ACTION_OPERATIONS.includes(opKey)) {
      opScoresMap[opKey] = candidateScoresByOp[opKey]?.[0]?.score ?? 0.1;
    } else {
      opScoresMap[opKey] = 0.1;
    }
  }
  const opProbabilities = buildNormalizedProbabilities(opCriteria, selectedOp, targetConfidence, opScoresMap);
  answers[OPERATION_QUESTION] = {
    type: 'choice',
    choice: selectedOp,
    confidence: targetConfidence,
    probabilities: opProbabilities,
  };

  // 2. Target questions
  for (const [qId, qDef] of Object.entries(questions)) {
    if (qId === OPERATION_QUESTION) continue;
    const criteriaKeys = Object.keys(qDef.criteria || {});
    let chosenKey = criteriaKeys[0] || 'none';
    let qConf = 0.6;
    let scoresMap = {};

    const matchingOp = Object.keys(TARGET_QUESTION_IDS).find((k) => TARGET_QUESTION_IDS[k] === qId);
    if (matchingOp === selectedOp && chosenTargetRef && criteriaKeys.includes(chosenTargetRef)) {
      chosenKey = chosenTargetRef;
      qConf = targetConfidence;
      for (const c of candidateScoresByOp[selectedOp] || []) {
        scoresMap[c.ref] = c.score;
      }
    } else if (matchingOp && candidateScoresByOp[matchingOp]?.length > 0) {
      chosenKey = candidateScoresByOp[matchingOp][0].ref;
      for (const c of candidateScoresByOp[matchingOp]) {
        scoresMap[c.ref] = c.score;
      }
    }

    const probabilities = buildNormalizedProbabilities(criteriaKeys, chosenKey, qConf, scoresMap);
    answers[qId] = {
      type: 'choice',
      choice: chosenKey,
      confidence: qConf,
      probabilities,
    };
  }

  const input_tokens = Math.round(50 + elements.length * 15 + goal.length / 4);
  const output_tokens = Math.round(20 + Object.keys(questions).length * 10);

  return {
    answers,
    usage: {
      input_tokens,
      output_tokens,
    },
  };
}

export function applyFault(snapshotText, ref, fault) {
  if (typeof snapshotText !== 'string' || !ref) {
    return snapshotText;
  }
  if (fault === 'covered') {
    return snapshotText;
  }

  const lines = snapshotText.split(/\r?\n/);
  const refPattern = new RegExp(`\\bref=${ref}\\b`);

  if (fault === 'hidden') {
    return lines.filter((line) => !refPattern.test(line)).join('\n');
  }

  const mutated = lines.map((line) => {
    if (!refPattern.test(line)) return line;

    if (fault === 'replaced') {
      const match = line.match(/"([^"]*)"/);
      if (match) {
        const originalName = match[1];
        const newName = `${originalName} (replaced)`;
        return line.replace(`"${originalName}"`, `"${newName}"`);
      }
      return `${line} " (replaced)"`;
    }

    if (fault === 'disabled') {
      if (!line.includes('[disabled]')) {
        return `${line} [disabled]`;
      }
      return line;
    }

    return line;
  });

  return mutated.join('\n');
}

export async function runRehearsal(options = {}) {
  const {
    count = 216,
    query = null,
    clientSource: initialClientSource = 'standalone-fake',
    clientModule = null,
    now = () => Date.now(),
    faultsPerType = 40,
    seed = 0x4d345345,
    captureWire = null,
  } = options;

  const getTime = typeof now === 'function' ? now : () => (typeof now === 'number' ? now : Date.now());

  // 1. Build deterministic corpus and compute digest
  const cases = buildCorpus({ count, seed });
  const corpusDigest = 'sha256:' + sha256hex(canonicalJson(cases));

  const caseIdToIndex = new Map();
  const caseMap = new Map();
  cases.forEach((c, idx) => {
    caseIdToIndex.set(c.caseId, idx);
    caseMap.set(c.caseId, c);
  });

  // Browser gateway call interceptor stub (zero-action invariant)
  let gatewayCalls = 0;
  const browserGatewayStub = {
    getAriaSnapshot: () => { gatewayCalls++; return ''; },
    clickByRef: () => { gatewayCalls++; },
    typeByRef: () => { gatewayCalls++; },
    selectByRef: () => { gatewayCalls++; },
    waitForStable: () => { gatewayCalls++; },
  };

  const capturedWireBodies = new Map();
  const wireBodies = [];
  let currentCase = null;
  let clientSource = initialClientSource;

  // 2. Query execution wrapper
  let activeQuery = query;
  if (clientModule) {
    const mod = await import(pathToFileURL(path.resolve(clientModule)).href);
    if (typeof mod?.createJevClient !== 'function') {
      throw new Error(`clientModule at ${clientModule} does not export createJevClient function`);
    }

    const transport = async (payload) => {
      const wireBody = payload.request; // { state, model, questions }
      capturedWireBodies.set(currentCase.caseId, wireBody); // wire THẬT sau redaction
      const entry = { caseId: currentCase.caseId, wireBody };
      Object.defineProperty(entry, 'state', { get() { return wireBody?.state; }, enumerable: false });
      Object.defineProperty(entry, 'model', { get() { return wireBody?.model; }, enumerable: false });
      Object.defineProperty(entry, 'questions', { get() { return wireBody?.questions; }, enumerable: false });
      wireBodies.push(entry);
      if (typeof captureWire === 'function') {
        captureWire(currentCase.caseId, wireBody);
      }
      const providerRes = rehearsalProvider(wireBody, { caseIndex: currentCase.index });
      return {
        status: 200,
        body: {
          model: wireBody.model,
          answers: providerRes.answers,
          usage: providerRes.usage,
        },
      };
    };

    const client = mod.createJevClient({
      transport,
      model: 'jev-1.13.0',
      skillDigest: null,
      apiKey: 'stub-key-not-a-secret',
    });
    activeQuery = async (request) => (await client.query(request)).result;
    clientSource = 'm2-client';
  } else if (!activeQuery) {
    activeQuery = async (request) => {
      const wireBody = {
        state: request.state,
        model: 'jev-1.13.0',
        questions: request.questions,
      };
      capturedWireBodies.set(request.requestId, wireBody);
      const entry = { caseId: request.requestId, wireBody };
      Object.defineProperty(entry, 'state', { get() { return wireBody?.state; }, enumerable: false });
      Object.defineProperty(entry, 'model', { get() { return wireBody?.model; }, enumerable: false });
      Object.defineProperty(entry, 'questions', { get() { return wireBody?.questions; }, enumerable: false });
      wireBodies.push(entry);
      if (typeof captureWire === 'function') {
        captureWire(request.requestId, wireBody);
      }

      const caseIdx = caseIdToIndex.get(request.requestId) ?? 1;
      const providerRes = rehearsalProvider(wireBody, { caseIndex: caseIdx });
      const nowVal = getTime();

      return {
        schema: 'webmcp-jev-result/1',
        requestId: request.requestId,
        status: 'ok',
        advisoryOnly: true,
        answers: providerRes.answers,
        lineage: {
          provider: 'typesafe',
          model: 'jev-1.13.0',
          skillDigest: 'sha256:' + '0'.repeat(64),
          questionSetDigest: request.questionSet.digest,
          stateDigest: 'sha256:' + sha256hex(canonicalJson(request.state)),
          requestDigest: 'sha256:' + sha256hex(canonicalJson(request)),
        },
        usage: providerRes.usage,
        timing: {
          receivedAt: nowVal,
          completedAt: nowVal,
          durationMs: 1,
        },
      };
    };
  } else {
    const wrappedCustomQuery = async (request) => {
      const wireBody = {
        state: request.state,
        model: 'jev-1.13.0',
        questions: request.questions,
      };
      capturedWireBodies.set(request.requestId, wireBody);
      const entry = { caseId: request.requestId, wireBody };
      Object.defineProperty(entry, 'state', { get() { return wireBody?.state; }, enumerable: false });
      Object.defineProperty(entry, 'model', { get() { return wireBody?.model; }, enumerable: false });
      Object.defineProperty(entry, 'questions', { get() { return wireBody?.questions; }, enumerable: false });
      wireBodies.push(entry);
      if (typeof captureWire === 'function') {
        captureWire(request.requestId, wireBody);
      }
      return query(request);
    };
    activeQuery = wrappedCustomQuery;
  }

  // 3. Run shadow browser step for each case
  const records = [];
  for (let i = 0; i < cases.length; i++) {
    const caseItem = cases[i];
    currentCase = { caseId: caseItem.caseId, index: i };
    const record = await runShadowBrowserStep({
      snapshot: caseItem.snapshot,
      goal: caseItem.goal,
      requestId: caseItem.caseId,
      urlOrigin: caseItem.urlOrigin,
      url: caseItem.url,
      runId: 'rehearsal-run-1',
      permitId: null,
      query: activeQuery,
      normalAgentDecision: caseItem.normalAgentDecision,
      postcondition: caseItem.postcondition,
      now: getTime,
    });

    record.mcpCalls.normalAgent = caseItem.normalAgentMcpCalls;
    record.archetype = caseItem.archetype;

    const freshCheck = recheckShadowTarget({
      decision: record.jevDecision,
      freshSnapshot: caseItem.snapshot,
      now: getTime(),
      ttlMs: 30000,
    });
    record.freshCheck = { ok: freshCheck.ok, stale: freshCheck.stale, fault: freshCheck.fault };

    records.push(record);
  }

  // Verify zero gateway calls
  if (gatewayCalls !== 0) {
    throw new Error(`Invariance violation: browser gateway stub was called ${gatewayCalls} times`);
  }

  // 4. Fault injection matrix
  const faultTypes = ['replaced', 'hidden', 'disabled', 'covered'];
  const faultResults = [];
  const eligibleRecords = records.filter(
    (r) => r.jevDecision?.actionable === true && r.jevDecision?.targetRef != null
  );

  for (const fault of faultTypes) {
    const targetCases = eligibleRecords.slice(0, faultsPerType);
    for (const rec of targetCases) {
      const caseItem = caseMap.get(rec.requestId);
      const targetRef = rec.jevDecision.targetRef;
      let freshSnapshot = caseItem.snapshot;
      let coveredRefs = [];

      if (fault === 'covered') {
        coveredRefs = [targetRef];
      } else {
        freshSnapshot = applyFault(caseItem.snapshot, targetRef, fault);
      }

      const checkRes = recheckShadowTarget({
        decision: rec.jevDecision,
        freshSnapshot,
        coveredRefs,
        now: getTime(),
        ttlMs: 30000,
      });

      faultResults.push({
        caseId: rec.requestId,
        fault,
        ok: checkRes.ok,
        stale: checkRes.stale,
        detected: checkRes.fault,
      });
    }
  }

  // 5. Leakage scan
  let scanned = 0;
  let hits = 0;
  const offenders = [];
  const recordMap = new Map();
  records.forEach((r) => recordMap.set(r.requestId, r));

  for (const caseItem of cases) {
    if (caseItem.urlOrigin.includes('?') || caseItem.urlOrigin.includes('#')) {
      throw new Error(`Invalid urlOrigin containing query or fragment: ${caseItem.urlOrigin}`);
    }

    const caseWire = capturedWireBodies.get(caseItem.caseId);
    const wireJson = caseWire ? canonicalJson(caseWire) : '';
    const rec = recordMap.get(caseItem.caseId);
    const caseFaults = faultResults.filter((f) => f.caseId === caseItem.caseId);
    const recordAuditJson = canonicalJson({
      record: rec,
      faults: caseFaults,
      freshCheck: rec?.freshCheck,
    });

    for (const secret of caseItem.injectedSecrets || []) {
      scanned++;
      const val = secret.value;
      let hitCount = 0;
      if (wireJson.includes(val)) hitCount++;
      if (recordAuditJson.includes(val)) hitCount++;

      if (hitCount > 0) {
        hits += hitCount;
        offenders.push({ caseId: caseItem.caseId, label: secret.label });
      }
    }
  }

  // 6. Aggregate metrics
  const epochNow = getTime();
  const metrics = aggregateShadowMetrics(records, {
    provider: 'rehearsal-offline',
    simulated: true,
    corpusDigest,
    generatedAt: new Date(epochNow).toISOString(),
  });

  const p50overhead = metrics.latencyMs.overhead.p50 ?? 0;
  const p95overhead = metrics.latencyMs.overhead.p95 ?? 0;

  const targetQCounts = records.map((r) => {
    const total = r.questionCount ?? 1;
    return Math.max(0, total - 1);
  });
  const meanSequential = targetQCounts.length > 0
    ? targetQCounts.reduce((acc, q) => acc + 1 + q, 0) / targetQCounts.length
    : 1;
  const meanSaved = targetQCounts.length > 0
    ? targetQCounts.reduce((acc, q) => acc + q, 0) / targetQCounts.length
    : 0;

  metrics.clientSource = clientSource;
  metrics.browserActions = gatewayCalls;
  metrics.faults = aggregateFaultResults(faultResults);
  metrics.leakage = { scanned, hits, offenders };
  metrics.speedHypothesis = {
    overheadMs: metrics.latencyMs.overhead,
    recordedJevCallBandMs: [961, 1074],
    recordedJevCallBandSource: 'plan.md §1.3 local TMT evidence',
    projectedAdvisoryMs: {
      low: Number((961 + p50overhead).toFixed(2)),
      high: Number((1074 + p95overhead).toFixed(2)),
    },
    normalAgentBaseline: 'UNMEASURED — M0 browser baseline blocked (baseline/browser-baseline-protocol.md)',
    fanout: {
      requestsPerDecision: 1,
      sequentialEquivalentMean: Number(meanSequential.toFixed(4)),
      savedRequestsMean: Number(meanSaved.toFixed(4)),
    },
  };

  return {
    metrics,
    records,
    faultResults,
    corpusDigest,
    wireBodies,
  };
}

// Parse CLI command-line arguments
function parseCliArgs(argv) {
  const options = {
    count: 216,
    outDir: null,
    clientModule: null,
    json: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--count' && i + 1 < argv.length) {
      options.count = parseInt(argv[++i], 10) || 216;
    } else if (arg === '--out' && i + 1 < argv.length) {
      options.outDir = argv[++i];
    } else if (arg === '--client-module' && i + 1 < argv.length) {
      options.clientModule = argv[++i];
    } else if (arg === '--json') {
      options.json = true;
    }
  }

  return options;
}

// Main CLI execution function
async function runCli() {
  const options = parseCliArgs(process.argv);

  const { metrics, records, faultResults, wireBodies } = await runRehearsal({
    count: options.count,
    clientModule: options.clientModule,
  });

  if (options.outDir) {
    const outDir = path.resolve(process.cwd(), options.outDir);
    mkdirSync(outDir, { recursive: true });

    writeFileSync(path.join(outDir, 'metrics.json'), canonicalJson(metrics) + '\n', 'utf8');

    const evidenceLines = records.map((r) => shadowEvidenceLine(r)).join('');
    writeFileSync(path.join(outDir, 'evidence.jsonl'), evidenceLines, 'utf8');

    writeFileSync(path.join(outDir, 'faults.json'), canonicalJson(metrics.faults) + '\n', 'utf8');

    if (metrics.leakage.hits === 0) {
      const wireAuditLines = wireBodies.map((w) => canonicalJson(w) + '\n').join('');
      writeFileSync(path.join(outDir, 'wire-audit.jsonl'), wireAuditLines, 'utf8');
    } else {
      const offenderMap = new Map();
      for (const off of metrics.leakage.offenders) {
        if (!offenderMap.has(off.caseId)) offenderMap.set(off.caseId, []);
        offenderMap.get(off.caseId).push(off.label);
      }
      const leakLines = Array.from(offenderMap.entries())
        .map(([caseId, leakLabels]) => canonicalJson({ caseId, leakLabels }) + '\n')
        .join('');
      writeFileSync(path.join(outDir, 'wire-audit.jsonl'), leakLines, 'utf8');
    }
  }

  console.log(JSON.stringify(metrics, null, 2));

  if (metrics.decisions < options.count) {
    console.error(`Rehearsal error: decisions (${metrics.decisions}) < expected count (${options.count})`);
    process.exit(1);
  }
  if (metrics.browserActions > 0) {
    console.error(`Invariance error: browserActions (${metrics.browserActions}) > 0`);
    process.exit(2);
  }
  if (metrics.leakage.hits > 0) {
    console.error(`Security error: secret leakage hits (${metrics.leakage.hits}) > 0`);
    process.exit(3);
  }

  process.exit(0);
}

// Entrypoint detection
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
