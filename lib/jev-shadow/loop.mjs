// lib/jev-shadow/loop.mjs
// M4 browser-step shadow fast loop core module.
// Invariant: Shadow only — zero execution authority, zero browser actions.

import { createHash } from 'node:crypto';

export const SHADOW_RECORD_SCHEMA = 'webmcp-jev-shadow/1';
export const DEFAULT_MAX_ELEMENTS = 80;
export const DEFAULT_MAX_STATE_BYTES = 32768;
export const DEFAULT_TTL_MS = 30000;
export const ACTION_OPERATIONS = Object.freeze(['CLICK', 'TYPE_TEXT', 'HOVER', 'SELECT']);
export const CONTROL_OPERATIONS = Object.freeze(['WAIT', 'DONE', 'BLOCKED']);
export const OPERATION_QUESTION = 'operation';
export const TARGET_QUESTION_IDS = Object.freeze({
  CLICK: 'click_target',
  TYPE_TEXT: 'type_text_target',
  HOVER: 'hover_target',
  SELECT: 'select_target',
});
export const SENSITIVE_VALUE_PATTERN = /password|passcode|passwd|pwd|secret|token|api[_ -]?key|otp|one[- ]?time[- ]?code|verification code|2fa|mfa|cvv|cvc|security code|card number|credit card|ssn/i;

export const ENGINE_VALUES = Object.freeze(['jev', 'normal-agent', 'deterministic', 'human', 'blocked', 'jev-shadow']);
export const OPERATION_VALUES = Object.freeze(['CLICK', 'TYPE_TEXT', 'HOVER', 'SELECT', 'WAIT', 'DONE', 'BLOCKED']);
export const METHOD_VALUES = Object.freeze([
  'snapshot-diff',
  'snapshot-verify',
  'dom-check',
  'text-match',
  'url-match',
  'attribute-check',
  'manual',
  'unknown',
]);
export const REF_PATTERN = /^[a-zA-Z0-9_:-]+$/;
export const CLOSED_REF_PATTERN = /^(?:r\d{1,4}|R\d{1,4}|S\d{1,4}|f\d{1,3}r\d{1,4}|F\d{1,3}:R\d{1,4}|e\d{1,4}|d\d{1,4}|D\d{1,4})$/;
export function isClosedRef(value) { return typeof value === 'string' && CLOSED_REF_PATTERN.test(value); }
export const LINEAGE_PROVIDER = 'typesafe';
export const LINEAGE_MODEL_PATTERN = /^jev-[0-9.]+$/;
export const LINEAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const FAILURE_CODES = Object.freeze([
  'JEV_CONFIG_MISSING',
  'JEV_AUTH_FAILED',
  'JEV_RATE_LIMITED',
  'JEV_OVERLOADED',
  'JEV_TIMEOUT',
  'JEV_TRANSPORT_FAILED',
  'JEV_REQUEST_INVALID',
  'JEV_RESPONSE_INVALID',
  'JEV_MODEL_MISMATCH',
  'JEV_CIRCUIT_OPEN',
  'PROVIDER_STATE_UNINITIALIZED',
  'PROVIDER_NO_ROUTE',
  'PROVIDER_BUSY',
  'REVIEW_BLOCKED_PROVIDER_ROUTE',
  'UNKNOWN',
]);
export const RESULT_REASONS = Object.freeze([
  'RESULT_INVALID',
  'ANSWER_INVALID',
  'TARGET_MISSING',
  'TARGET_INCOMPATIBLE',
  'TARGET_UNAVAILABLE',
  'DIGEST_MISMATCH',
  'TTL_EXPIRED',
  'NO_TARGET',
  'BINDING_MISSING',
  'UNKNOWN',
]);

const GOAL_SECRET_CUES = 'password|passwd|pwd|passcode|mật\\s*khẩu|mat\\s*khau|token|secret|api[\\s_-]?key|otp|one[- ]?time[- ]?code|verification code|session(?:id)?|cookie|authorization|bearer';
export const GOAL_SECRET_PATTERNS = Object.freeze([
  new RegExp(`(?:${GOAL_SECRET_CUES})\\s*[:=]\\s*\\S+`, 'iu'),
  new RegExp(`(?:${GOAL_SECRET_CUES})\\s+\\d{4,}\\b`, 'iu'),
  /eyJ[A-Za-z0-9_-]{8,}\./,
  /sk-[A-Za-z0-9-]{12,}/,
  /ghp_[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{12,}/,
  /\b[0-9a-f]{32,}\b/i,
  /(?:\d[ -]?){13,19}\d/,
]);

export function goalCarriesSecret(goal) {
  if (typeof goal !== 'string') return false;
  return GOAL_SECRET_PATTERNS.some((pattern) => pattern.test(goal));
}

// Scrub sensitive strings against known secret patterns, truncating to 200 characters.
export function scrubEvidenceText(value) {
  if (typeof value !== 'string') {
    return value;
  }
  if (GOAL_SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
    return '[REDACTED]';
  }
  return value.slice(0, 200);
}

// Project normalAgentDecision to whitelist fields { engine, operation, targetRef } and scrub strings.
export function projectNormalAgentDecision(decision, { elementRefs = null } = {}) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    return null;
  }
  const projected = {};

  if ('engine' in decision && decision.engine !== undefined) {
    if (decision.engine === null) {
      projected.engine = 'normal-agent';
    } else if (typeof decision.engine === 'string') {
      const trimmed = decision.engine.trim();
      if (trimmed === '') {
        projected.engine = 'normal-agent';
      } else if (ENGINE_VALUES.includes(trimmed)) {
        projected.engine = trimmed;
      } else {
        projected.engine = '[REDACTED]';
      }
    } else {
      projected.engine = '[REDACTED]';
    }
  }

  if ('operation' in decision && decision.operation !== undefined) {
    if (decision.operation === null) {
      projected.operation = null;
    } else if (typeof decision.operation === 'string' && OPERATION_VALUES.includes(decision.operation.trim())) {
      projected.operation = decision.operation.trim();
    } else {
      projected.operation = '[REDACTED]';
    }
  }

  if ('targetRef' in decision && decision.targetRef !== undefined) {
    if (decision.targetRef === null) {
      projected.targetRef = null;
    } else {
      const targetRef = decision.targetRef;
      const hasRef = Boolean(
        elementRefs &&
        (elementRefs instanceof Set || typeof elementRefs.has === 'function'
          ? elementRefs.has(targetRef)
          : Array.isArray(elementRefs)
            ? elementRefs.includes(targetRef)
            : false)
      );

      if (
        hasRef &&
        typeof targetRef === 'string' &&
        targetRef.length <= 64 &&
        isClosedRef(targetRef) &&
        scrubEvidenceText(targetRef) === targetRef
      ) {
        projected.targetRef = targetRef;
      } else {
        projected.targetRef = '[REDACTED]';
      }
    }
  }

  return projected;
}

// Project postcondition to whitelist { verified, method, satisfied } and scrub strings.
export function projectPostcondition(postcondition) {
  if (!postcondition || typeof postcondition !== 'object' || Array.isArray(postcondition)) {
    return null;
  }
  const projected = {};

  if ('verified' in postcondition && postcondition.verified !== undefined) {
    if (typeof postcondition.verified === 'boolean' || postcondition.verified === null) {
      projected.verified = postcondition.verified;
    }
  }

  if ('method' in postcondition && postcondition.method !== undefined) {
    if (postcondition.method === null) {
      projected.method = null;
    } else if (
      typeof postcondition.method === 'string' &&
      METHOD_VALUES.includes(postcondition.method) &&
      scrubEvidenceText(postcondition.method) === postcondition.method
    ) {
      projected.method = postcondition.method;
    } else {
      projected.method = '[REDACTED]';
    }
  }

  if ('satisfied' in postcondition && postcondition.satisfied !== undefined) {
    if (typeof postcondition.satisfied === 'boolean' || postcondition.satisfied === null) {
      projected.satisfied = postcondition.satisfied;
    }
  }

  return projected;
}

// Project lineage to closed 6 fields: provider, model, 4 digests.
export function projectLineage(lineage) {
  if (!lineage || typeof lineage !== 'object' || Array.isArray(lineage)) {
    return null;
  }
  const checkDigest = (v) =>
    typeof v === 'string' && LINEAGE_DIGEST_PATTERN.test(v) ? v : '[REDACTED]';

  return {
    provider: lineage.provider === 'typesafe' ? 'typesafe' : '[REDACTED]',
    model:
      typeof lineage.model === 'string' &&
      LINEAGE_MODEL_PATTERN.test(lineage.model) &&
      scrubEvidenceText(lineage.model) === lineage.model
        ? lineage.model
        : '[REDACTED]',
    skillDigest: checkDigest(lineage.skillDigest),
    questionSetDigest: checkDigest(lineage.questionSetDigest),
    stateDigest: checkDigest(lineage.stateDigest),
    requestDigest: checkDigest(lineage.requestDigest),
  };
}

// Sanitize reason code to closed failure code enum or fallback to 'UNKNOWN'.
export function sanitizeReasonCode(code) {
  return typeof code === 'string' && FAILURE_CODES.includes(code) ? code : 'UNKNOWN';
}

// Sanitize result reason to closed result reasons enum or fallback to 'UNKNOWN'.
export function sanitizeResultReason(reason) {
  return typeof reason === 'string' && RESULT_REASONS.includes(reason) ? reason : 'UNKNOWN';
}

// Closed confidence helper: finite float in [0, 1] or null.
export function closedConfidence(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

// Format epoch milliseconds as ISO string or null.
export function isoOrNull(ms) {
  try {
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  } catch {
    return null;
  }
}

const ORIGIN_PATTERN = /^https?:\/\/[a-zA-Z0-9.-]+(:[0-9]+)?$/;
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]+(@[a-zA-Z0-9_.-]+)?$/;

// Construct typed Error carrying .code property without class inheritance overhead.
export function shadowError(code, message) {
  const error = new Error(message ? `${code}: ${message}` : code);
  error.code = code;
  return error;
}

// Compute SHA-256 hexadecimal digest for deterministic hashing.
export function sha256hex(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

// Deterministic recursive JSON stringification with sorted keys.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(',')}}`;
}

// Derive origin from a URL ensuring only http/https and no path/query/fragment/creds.
export function deriveUrlOrigin(url) {
  if (typeof url !== 'string' || !url.trim()) {
    throw shadowError('SNAPSHOT_INVALID', 'URL must be a non-empty string');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw shadowError('SNAPSHOT_INVALID', `Failed to parse URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw shadowError('SNAPSHOT_INVALID', `Unsupported protocol in URL: ${parsed.protocol}`);
  }
  const origin = parsed.origin;
  if (!ORIGIN_PATTERN.test(origin)) {
    throw shadowError('SNAPSHOT_INVALID', `Derived origin violates origin pattern: ${origin}`);
  }
  return origin;
}

// Parse quoted string with backslash escape support: \" -> " and \\ -> \.
function parseQuotedString(str, startPos) {
  if (str[startPos] !== '"') return null;
  let out = '';
  let i = startPos + 1;
  while (i < str.length) {
    const ch = str[i];
    if (ch === '\\' && i + 1 < str.length) {
      const next = str[i + 1];
      if (next === '"' || next === '\\') {
        out += next;
        i += 2;
      } else {
        out += next;
        i += 2;
      }
    } else if (ch === '"') {
      return { value: out, nextPos: i + 1 };
    } else {
      out += ch;
      i++;
    }
  }
  return null; // Unterminated quote
}

// Parse multi-line ARIA snapshot string into structured entries and stats.
export function parseAriaSnapshot(text) {
  if (typeof text !== 'string') {
    throw shadowError('SNAPSHOT_INVALID', 'Snapshot text must be a string');
  }

  const rawLines = text.endsWith('\n') ? text.slice(0, -1).split(/\r?\n/) : text.split(/\r?\n/);
  const entries = [];
  const stats = {
    lines: rawLines.length,
    elements: 0,
    texts: 0,
    documents: 0,
    options: 0,
    notes: 0,
    noteTruncated: 0,
    malformed: 0,
  };

  for (let rawLine of rawLines) {
    let lineMalformed = false;
    // Lines exceeding 2000 characters are truncated and flagged as malformed.
    if (rawLine.length > 2000) {
      rawLine = rawLine.slice(0, 2000);
      lineMalformed = true;
      stats.malformed++;
    }

    // Every line starts with zero or more spaces followed by hyphen-space "- ".
    const match = rawLine.match(/^( *)- (.*)$/);
    if (!match) {
      if (!lineMalformed) stats.malformed++;
      continue;
    }

    const indent = Math.floor(match[1].length / 2);
    const body = match[2].trim();
    if (!body) {
      if (!lineMalformed) stats.malformed++;
      continue;
    }

    // Check for element line starting with "ref="
    if (body.startsWith('ref=')) {
      const spaceIdx = body.indexOf(' ');
      const refToken = spaceIdx === -1 ? body.slice(4) : body.slice(4, spaceIdx);
      if (!refToken) {
        if (!lineMalformed) stats.malformed++;
        continue;
      }

      const rest = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1).trim();
      const roleSpaceIdx = rest.indexOf(' ');
      const role = roleSpaceIdx === -1 ? rest : rest.slice(0, roleSpaceIdx);
      if (!role || role.startsWith('"') || role.startsWith('[')) {
        if (!lineMalformed) stats.malformed++;
        continue;
      }

      const tail = roleSpaceIdx === -1 ? '' : rest.slice(roleSpaceIdx + 1).trim();
      let name = '';
      let value = '';
      let headingLevel = null;
      const states = {
        disabled: false,
        required: false,
        checked: null,
        selected: null,
        expanded: null,
      };

      // Sequential scan over tail tokens
      let pos = 0;
      let parseFailed = false;
      while (pos < tail.length) {
        while (pos < tail.length && tail[pos] === ' ') pos++;
        if (pos >= tail.length) break;

        if (tail[pos] === '"') {
          const parsed = parseQuotedString(tail, pos);
          if (!parsed) { parseFailed = true; break; }
          name = parsed.value;
          pos = parsed.nextPos;
        } else if (tail.startsWith('value="', pos)) {
          const parsed = parseQuotedString(tail, pos + 6);
          if (!parsed) { parseFailed = true; break; }
          value = parsed.value;
          pos = parsed.nextPos;
        } else if (tail.startsWith('(h', pos)) {
          const hMatch = tail.slice(pos).match(/^\(h([1-6])\)/);
          if (hMatch) {
            headingLevel = parseInt(hMatch[1], 10);
            pos += hMatch[0].length;
          } else {
            pos++;
          }
        } else if (tail[pos] === '[') {
          const closeIdx = tail.indexOf(']', pos);
          if (closeIdx === -1) { parseFailed = true; break; }
          const bracketContent = tail.slice(pos + 1, closeIdx);
          pos = closeIdx + 1;

          if (bracketContent === 'disabled') {
            states.disabled = true;
          } else if (bracketContent === 'required') {
            states.required = true;
          } else if (bracketContent === 'selected') {
            states.selected = true;
          } else if (bracketContent === 'checked=true' || bracketContent === 'checked') {
            states.checked = true;
          } else if (bracketContent === 'checked=false') {
            states.checked = false;
          } else if (bracketContent === 'checked=mixed') {
            states.checked = 'mixed';
          } else if (bracketContent === 'expanded=true' || bracketContent === 'expanded') {
            states.expanded = true;
          } else if (bracketContent === 'expanded=false') {
            states.expanded = false;
          }
        } else {
          // Unknown token character; advance past non-space characters
          while (pos < tail.length && tail[pos] !== ' ') pos++;
        }
      }

      if (parseFailed) {
        if (!lineMalformed) stats.malformed++;
        continue;
      }

      entries.push({
        kind: 'element',
        indent,
        ref: refToken,
        role,
        name,
        value,
        states,
        headingLevel,
        raw: rawLine,
      });
      stats.elements++;
      continue;
    }

    // Non-element lines: document, text, option, note
    if (body.startsWith('document')) {
      const rest = body.slice(8).trim();
      let name = '';
      if (rest.startsWith('"')) {
        const parsed = parseQuotedString(rest, 0);
        if (parsed) name = parsed.value;
      }
      entries.push({
        kind: 'document',
        indent,
        ref: null,
        role: null,
        name,
        value: '',
        states: { disabled: false, required: false, checked: null, selected: null, expanded: null },
        headingLevel: null,
        raw: rawLine,
      });
      stats.documents++;
      continue;
    }

    if (body.startsWith('text')) {
      const rest = body.slice(4).trim();
      let name = '';
      if (rest.startsWith('"')) {
        const parsed = parseQuotedString(rest, 0);
        if (parsed) name = parsed.value;
      }
      entries.push({
        kind: 'text',
        indent,
        ref: null,
        role: null,
        name,
        value: '',
        states: { disabled: false, required: false, checked: null, selected: null, expanded: null },
        headingLevel: null,
        raw: rawLine,
      });
      stats.texts++;
      continue;
    }

    if (body.startsWith('note')) {
      const rest = body.slice(4).trim();
      let name = '';
      if (rest.startsWith('"')) {
        const parsed = parseQuotedString(rest, 0);
        if (parsed) name = parsed.value;
      }
      const isTruncated = /truncat/i.test(name) || /truncat/i.test(rest);
      if (isTruncated) {
        stats.noteTruncated++;
      }
      entries.push({
        kind: 'note',
        indent,
        ref: null,
        role: null,
        name,
        value: '',
        states: { disabled: false, required: false, checked: null, selected: null, expanded: null },
        headingLevel: null,
        truncated: isTruncated,
        raw: rawLine,
      });
      stats.notes++;
      continue;
    }

    if (body.startsWith('option')) {
      const tail = body.slice(6).trim();
      let name = '';
      let value = '';
      const states = { disabled: false, required: false, checked: null, selected: null, expanded: null };
      let pos = 0;
      while (pos < tail.length) {
        while (pos < tail.length && tail[pos] === ' ') pos++;
        if (pos >= tail.length) break;
        if (tail[pos] === '"') {
          const parsed = parseQuotedString(tail, pos);
          if (parsed) { name = parsed.value; pos = parsed.nextPos; } else { pos++; }
        } else if (tail.startsWith('value="', pos)) {
          const parsed = parseQuotedString(tail, pos + 6);
          if (parsed) { value = parsed.value; pos = parsed.nextPos; } else { pos++; }
        } else if (tail.startsWith('[selected]', pos)) {
          states.selected = true;
          pos += 10;
        } else if (tail.startsWith('[disabled]', pos)) {
          states.disabled = true;
          pos += 10;
        } else {
          pos++;
        }
      }
      entries.push({
        kind: 'option',
        indent,
        ref: null,
        role: 'option',
        name,
        value,
        states,
        headingLevel: null,
        raw: rawLine,
      });
      stats.options++;
      continue;
    }

    // Any unrecognized non-element line is tracked as malformed
    if (!lineMalformed) stats.malformed++;
  }

  return { entries, stats };
}

// Mapping of role to supported browser operations.
// Note: HOVER is deliberately omitted here per plan/spec because snapshot lacks hover signals.
const ROLE_OPERATIONS = Object.freeze({
  button: ['CLICK'],
  link: ['CLICK'],
  menuitem: ['CLICK'],
  menuitemcheckbox: ['CLICK'],
  menuitemradio: ['CLICK'],
  tab: ['CLICK'],
  option: ['CLICK'],
  treeitem: ['CLICK'],
  checkbox: ['CLICK'],
  radio: ['CLICK'],
  switch: ['CLICK'],
  slider: ['CLICK'],
  textbox: ['TYPE_TEXT'],
  searchbox: ['TYPE_TEXT'],
  spinbutton: ['TYPE_TEXT'],
  combobox: ['SELECT'],
  listbox: ['SELECT'],
  select: ['SELECT'],
});

const PRESENTATIONAL_ROLES = new Set(['presentation', 'none', 'generic']);
const SENSITIVE_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox']);

// Normalize raw snapshot text or object into filtered compact elements and digest.
export function normalizeAriaSnapshot(snapshot, options = {}) {
  let sourceText = null;
  if (typeof snapshot === 'string') {
    sourceText = snapshot;
  } else if (snapshot && typeof snapshot === 'object') {
    if (typeof snapshot.snapshot === 'string') {
      sourceText = snapshot.snapshot;
    } else if (typeof snapshot.text === 'string') {
      sourceText = snapshot.text;
    }
  }

  if (sourceText === null) {
    throw shadowError('SNAPSHOT_INVALID', 'Invalid snapshot input: expected string or object with snapshot/text property');
  }

  const {
    maxElements = DEFAULT_MAX_ELEMENTS,
    maxStateBytes = DEFAULT_MAX_STATE_BYTES,
    maxNameLength = 120,
    maxValueLength = 80,
    includeDisabled = false,
  } = options;

  const snapshotDigest = 'sha256:' + sha256hex(sourceText);
  const { entries, stats: parseStats } = parseAriaSnapshot(sourceText);

  const stats = {
    lines: parseStats.lines,
    parsed: entries.length,
    elements: 0,
    droppedDisabled: 0,
    droppedNoOps: 0,
    droppedUnref: 0,
    droppedPresentational: 0,
    droppedRefGrammar: 0,
    redactedValues: 0,
    truncated: false,
    bytesTruncated: false,
    noteTruncated: parseStats.noteTruncated || 0,
    bytes: 0,
  };

  const rawElements = [];
  const ancestorStack = []; // Stack of { indent, name } to derive parentContext

  for (const entry of entries) {
    // Pop ancestor stack back to current indent level
    while (ancestorStack.length > 0 && ancestorStack[ancestorStack.length - 1].indent >= entry.indent) {
      ancestorStack.pop();
    }

    // Closest 3 ancestors from root down to immediate parent
    const parentContext = ancestorStack
      .map((item) => item.name)
      .filter((n) => Boolean(n && n.trim()))
      .slice(-3);

    // If this line has a meaningful name, push to ancestor stack for deeper nodes
    if ((entry.kind === 'element' || entry.kind === 'document') && entry.name && entry.name.trim()) {
      ancestorStack.push({
        indent: entry.indent,
        name: entry.name.slice(0, maxNameLength),
      });
    }

    if (entry.kind !== 'element' || !entry.ref) {
      stats.droppedUnref++;
      continue;
    }

    if (!isClosedRef(entry.ref)) {
      stats.droppedRefGrammar++;
      continue;
    }

    if (PRESENTATIONAL_ROLES.has(entry.role)) {
      stats.droppedPresentational++;
      continue;
    }

    if (entry.states.disabled && !includeDisabled) {
      stats.droppedDisabled++;
      continue;
    }

    const operations = ROLE_OPERATIONS[entry.role] ? [...ROLE_OPERATIONS[entry.role]] : [];
    if (operations.length === 0) {
      stats.droppedNoOps++;
      continue;
    }

    let value = entry.value || '';
    if (value === '[value redacted]' || (SENSITIVE_ROLES.has(entry.role) && SENSITIVE_VALUE_PATTERN.test(entry.name))) {
      value = '';
      stats.redactedValues++;
    }

    const trimmedName = (entry.name || '').slice(0, maxNameLength);
    const trimmedValue = value.slice(0, maxValueLength);

    rawElements.push({
      ref: entry.ref,
      role: entry.role,
      name: trimmedName,
      value: trimmedValue,
      enabled: !entry.states.disabled,
      visible: true,
      operations,
      checked: entry.states.checked === 'mixed' ? null : entry.states.checked,
      selected: entry.states.selected ?? null,
      expanded: entry.states.expanded ?? null,
      parentContext,
    });
  }

  let elements = rawElements;
  let coverageUncertain = Boolean((parseStats.noteTruncated || 0) > 0);

  // Enforce maxElements ceiling
  if (elements.length > maxElements) {
    elements = elements.slice(0, maxElements);
    coverageUncertain = true;
    stats.truncated = true;
  }

  // Enforce maxStateBytes ceiling on elements array
  while (elements.length > 0 && Buffer.byteLength(JSON.stringify(elements)) > maxStateBytes) {
    elements.pop();
    coverageUncertain = true;
    stats.bytesTruncated = true;
  }

  stats.elements = elements.length;
  stats.bytes = Buffer.byteLength(JSON.stringify(elements));

  return {
    elements,
    stats,
    snapshotDigest,
    coverageUncertain,
  };
}

// Build webmcp-jev-request/1 payload for browser-step micro-decisions.
export function buildBrowserStepRequest(input) {
  if (!input || typeof input !== 'object') {
    throw shadowError('REQUEST_INVALID', 'Input must be an object');
  }

  const {
    snapshot,
    goal,
    requestId,
    runId,
    permitId = null,
    bounds: rawBounds = {},
    recentActions = [],
    maxElements,
  } = input;

  let urlOrigin = input.urlOrigin || null;
  if (!urlOrigin) {
    urlOrigin = deriveUrlOrigin(input.url);
  } else if (!ORIGIN_PATTERN.test(urlOrigin)) {
    throw shadowError('SNAPSHOT_INVALID', `urlOrigin violates format requirement: ${urlOrigin}`);
  }

  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    throw shadowError('REQUEST_INVALID', `Invalid requestId format: ${requestId}`);
  }

  if (typeof goal !== 'string' || !goal.trim()) {
    throw shadowError('REQUEST_INVALID', 'Goal must be a non-empty string');
  }

  if (goalCarriesSecret(goal)) {
    throw shadowError('REQUEST_INVALID', 'goal carries secret-shaped text; pass a high-level intent only');
  }

  if (typeof runId !== 'string' || !runId.trim()) {
    throw shadowError('REQUEST_INVALID', 'runId must be a non-empty string');
  }

  const bounds = {
    maxStateBytes: DEFAULT_MAX_STATE_BYTES,
    maxQuestions: 8,
    timeoutMs: 2000,
    maxRetries: 1,
    ...rawBounds,
  };

  const norm = normalizeAriaSnapshot(snapshot, {
    maxElements,
    maxStateBytes: bounds.maxStateBytes,
  });

  let elements = norm.elements;
  let coverageUncertain = norm.coverageUncertain;
  const snapshotDigest = norm.snapshotDigest;
  const stats = norm.stats;

  // Trim elements from tail if state size exceeds bounds.maxStateBytes
  let state = { snapshotDigest, urlOrigin, goal, elements, recentActions };
  while (elements.length > 0 && Buffer.byteLength(canonicalJson(state)) > bounds.maxStateBytes) {
    elements.pop();
    coverageUncertain = true;
    state = { snapshotDigest, urlOrigin, goal, elements, recentActions };
  }

  if (Buffer.byteLength(canonicalJson(state)) > bounds.maxStateBytes) {
    throw shadowError('REQUEST_INVALID', 'State payload exceeds maxStateBytes bound even with 0 elements');
  }

  // Partition elements by candidate operations
  const byOperation = {};
  for (const el of elements) {
    for (const op of el.operations) {
      (byOperation[op] ||= []).push(el);
    }
  }

  // Primary operation choice criteria
  const operationCriteria = {};
  for (const op of Object.keys(byOperation)) {
    operationCriteria[op] = null;
  }
  operationCriteria.WAIT = 'Required control is temporarily unavailable or page is loading.';
  operationCriteria.DONE = 'Every requested postcondition is visibly satisfied.';
  operationCriteria.BLOCKED = 'No offered operation can make progress safely.';

  const questions = {
    [OPERATION_QUESTION]: {
      type: 'choice',
      instructions: {
        goal,
        question: 'Choose exactly one next operation.',
      },
      criteria: operationCriteria,
    },
  };

  const questionIds = [OPERATION_QUESTION];
  const targetFingerprints = {};

  // Construct target choice questions for each operation with available candidates
  for (const [op, candidates] of Object.entries(byOperation)) {
    const qId = TARGET_QUESTION_IDS[op];
    if (!qId) continue;

    const targetCriteria = {};
    for (const el of candidates) {
      targetCriteria[el.ref] = {
        role: el.role,
        name: el.name,
        value: el.value,
      };
      if (el.ref !== 'none' && el.ref !== 'NONE') {
        targetFingerprints[el.ref] = 'sha256:' + sha256hex(`${el.role}\0${el.name}\0${el.value}\0${el.operations.join(',')}`);
      }
    }

    // none ref is offered when element coverage was truncated or uncertain
    if (coverageUncertain) {
      targetCriteria.none = null;
    }

    questions[qId] = {
      type: 'choice',
      instructions: {
        goal,
        assumedOperation: op,
        question: 'Choose one offered ref if this operation is selected.',
      },
      criteria: targetCriteria,
    };
    questionIds.push(qId);
  }

  if (Object.keys(questions).length > bounds.maxQuestions) {
    throw shadowError('REQUEST_INVALID', `Generated question count (${Object.keys(questions).length}) exceeds maxQuestions (${bounds.maxQuestions})`);
  }

  const questionSetDigest = 'sha256:' + sha256hex(canonicalJson(questions));
  const questionSet = {
    id: 'browser-step',
    version: 1,
    digest: questionSetDigest,
  };

  const request = {
    schema: 'webmcp-jev-request/1',
    requestId,
    kind: 'browser-step',
    state,
    questionSet,
    questions,
    bounds,
    caller: {
      runId,
      permitId: permitId ?? null,
    },
    fallbackPolicy: 'normal-agent',
  };

  return {
    request,
    elements,
    snapshotDigest,
    stats,
    coverageUncertain,
    questionIds,
    targetFingerprints,
  };
}

// Validate a choice answer against its question criteria definition.
function isValidChoiceAnswer(ans, qDef) {
  if (!ans || typeof ans !== 'object' || Array.isArray(ans) || ans.type !== 'choice') {
    return false;
  }

  const criteriaKeys = qDef?.criteria ? Object.keys(qDef.criteria) : [];
  if (criteriaKeys.length === 0 || !criteriaKeys.includes(ans.choice)) {
    return false;
  }

  const probs = ans.probabilities;
  if (!probs || typeof probs !== 'object' || Array.isArray(probs)) {
    return false;
  }

  const probKeys = Object.keys(probs);
  if (
    probKeys.length !== criteriaKeys.length ||
    !criteriaKeys.every((k) => Object.prototype.hasOwnProperty.call(probs, k))
  ) {
    return false;
  }

  const values = Object.values(probs);
  if (values.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)) {
    return false;
  }

  const sum = values.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 0.02) {
    return false;
  }

  const maxVal = Math.max(...values);
  if (probs[ans.choice] < maxVal - 1e-6) {
    return false;
  }

  if (typeof ans.confidence !== 'number' || !Number.isFinite(ans.confidence) || ans.confidence < 0 || ans.confidence > 1) {
    return false;
  }

  return true;
}

// Validate decision results strictly per contract and plan §6.5.
export function validateShadowDecision(result, context = {}) {
  const {
    request,
    elements = [],
    snapshotDigest = null,
    boundAt = null,
    ttlMs = DEFAULT_TTL_MS,
  } = context;

  const now = typeof context.now === 'function' ? context.now() : (context.now ?? Date.now());
  const reasons = [];
  let invalid = false;
  let stale = false;

  const effectiveBoundAt = Number.isFinite(boundAt) ? boundAt : (Number.isFinite(now) ? now : null);
  if (!Number.isFinite(now) || !Number.isFinite(effectiveBoundAt) || now - effectiveBoundAt > ttlMs) {
    if (!reasons.includes('TTL_EXPIRED')) reasons.push('TTL_EXPIRED');
    stale = true;
  }

  if (!result || typeof result !== 'object') {
    if (!reasons.includes('RESULT_INVALID')) reasons.push('RESULT_INVALID');
    return { ok: false, invalid: true, stale, actionable: false, reasons: reasons.map(sanitizeResultReason), decision: null };
  }

  if (
    result.schema !== 'webmcp-jev-result/1' ||
    result.status !== 'ok' ||
    result.advisoryOnly !== true ||
    (request && result.requestId !== request.requestId)
  ) {
    if (!reasons.includes('RESULT_INVALID')) reasons.push('RESULT_INVALID');
    invalid = true;
  }

  const answers = result.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers) || !(OPERATION_QUESTION in answers)) {
    if (!reasons.includes('ANSWER_INVALID')) reasons.push('ANSWER_INVALID');
    return { ok: false, invalid: true, stale, actionable: false, reasons: reasons.map(sanitizeResultReason), decision: null };
  }

  const offeredQuestions = request?.questions && typeof request.questions === 'object'
    ? request.questions
    : {};

  // Rule 2 & Rule 5: Every answer key must be an offered question id.
  // Validate all present answers as choices against question criteria.
  for (const qId of Object.keys(answers)) {
    if (!Object.prototype.hasOwnProperty.call(offeredQuestions, qId)) {
      if (!reasons.includes('ANSWER_INVALID')) reasons.push('ANSWER_INVALID');
      invalid = true;
      continue;
    }

    const ans = answers[qId];
    const qDef = offeredQuestions[qId];
    if (!isValidChoiceAnswer(ans, qDef)) {
      if (!reasons.includes('ANSWER_INVALID')) reasons.push('ANSWER_INVALID');
      invalid = true;
    }
  }

  const opAnswer = answers[OPERATION_QUESTION];
  const rawOp = opAnswer?.choice;
  let operation;
  if (typeof rawOp === 'string' && OPERATION_VALUES.includes(rawOp)) {
    operation = rawOp;
  } else if (rawOp === null || rawOp === undefined) {
    operation = null;
  } else {
    operation = '[REDACTED]';
  }

  if (operation === null) {
    if (!reasons.includes('ANSWER_INVALID')) reasons.push('ANSWER_INVALID');
    return { ok: false, invalid: true, stale, actionable: false, reasons: reasons.map(sanitizeResultReason), decision: null };
  }

  let targetRef = null;
  let actionable = false;
  let fingerprint = null;
  const opConf = closedConfidence(opAnswer?.confidence);
  let confidence = opConf;

  if (CONTROL_OPERATIONS.includes(operation)) {
    targetRef = null;
    actionable = true;
  } else if (ACTION_OPERATIONS.includes(operation)) {
    const targetQId = TARGET_QUESTION_IDS[operation];
    const targetAnswer = targetQId ? answers[targetQId] : null;

    if (!targetAnswer) {
      if (!reasons.includes('ANSWER_INVALID')) reasons.push('ANSWER_INVALID');
      invalid = true;
      confidence = null;
    } else {
      const targetConf = closedConfidence(targetAnswer.confidence);
      if (opConf !== null && targetConf !== null) {
        confidence = Math.min(opConf, targetConf);
      } else {
        confidence = null;
      }

      const chosenRef = targetAnswer.choice;

      if (chosenRef === 'none') {
        targetRef = null;
        actionable = false;
        if (!reasons.includes('NO_TARGET')) reasons.push('NO_TARGET');
      } else if (!isClosedRef(chosenRef)) {
        targetRef = '[REDACTED]';
        if (!reasons.includes('TARGET_MISSING')) reasons.push('TARGET_MISSING');
        invalid = true;
        actionable = false;
      } else {
        targetRef = chosenRef;
        const targetElement = elements.find((el) => el.ref === targetRef);

        if (!targetElement) {
          if (!reasons.includes('TARGET_MISSING')) reasons.push('TARGET_MISSING');
          invalid = true;
        } else if (!targetElement.operations.includes(operation)) {
          if (!reasons.includes('TARGET_INCOMPATIBLE')) reasons.push('TARGET_INCOMPATIBLE');
          invalid = true;
        } else if (targetElement.enabled === false) {
          if (!reasons.includes('TARGET_UNAVAILABLE')) reasons.push('TARGET_UNAVAILABLE');
          invalid = true;
        } else {
          actionable = true;
          fingerprint = 'sha256:' + sha256hex(`${targetElement.role}\0${targetElement.name}\0${targetElement.value}\0${targetElement.operations.join(',')}`);
        }
      }
    }
  }

  // Digest binding verification
  const boundSnapshotDigest = request?.state?.snapshotDigest || null;
  if (snapshotDigest && boundSnapshotDigest && snapshotDigest !== boundSnapshotDigest) {
    if (!reasons.includes('DIGEST_MISMATCH')) reasons.push('DIGEST_MISMATCH');
    stale = true;
  }

  const decision = {
    operation,
    targetRef,
    confidence,
    snapshotDigest: boundSnapshotDigest,
    decidedAt: Number.isFinite(effectiveBoundAt) ? effectiveBoundAt : null,
    fingerprint,
  };

  const isOnlyNoTarget = reasons.length === 1 && reasons[0] === 'NO_TARGET';
  const ok = reasons.length === 0 || isOnlyNoTarget;

  return {
    ok,
    invalid,
    stale,
    actionable: ok && actionable,
    reasons: reasons.map(sanitizeResultReason),
    decision,
  };
}

// Re-check target existence and structural integrity on a fresh observation snapshot.
export function recheckShadowTarget(context = {}) {
  const {
    decision,
    freshSnapshot,
    coveredRefs = [],
    ttlMs = DEFAULT_TTL_MS,
  } = context;

  const now = typeof context.now === 'function' ? context.now() : (context.now ?? Date.now());

  if (!decision || decision.targetRef == null) {
    return { ok: true, stale: false, fault: null, reasons: [] };
  }

  // Fail-closed when binding fields are missing or invalid
  if (typeof decision.decidedAt !== 'number' || !Number.isFinite(decision.decidedAt)) {
    return { ok: false, stale: true, fault: 'unbound', reasons: ['BINDING_MISSING'] };
  }

  if (typeof decision.fingerprint !== 'string' || !decision.fingerprint.trim()) {
    return { ok: false, stale: true, fault: 'unbound', reasons: ['BINDING_MISSING'] };
  }

  // TTL expiration check
  if (now - decision.decidedAt > ttlMs) {
    return { ok: false, stale: true, fault: 'expired', reasons: ['TTL_EXPIRED'] };
  }

  // Normalize fresh observation snapshot retaining disabled controls
  const norm = normalizeAriaSnapshot(freshSnapshot, {
    maxElements: 10000,
    includeDisabled: true,
  });

  const targetEl = norm.elements.find((el) => el.ref === decision.targetRef);
  if (!targetEl) {
    return { ok: false, stale: true, fault: 'hidden', reasons: ['TARGET_HIDDEN'] };
  }

  const freshFp = 'sha256:' + sha256hex(`${targetEl.role}\0${targetEl.name}\0${targetEl.value}\0${targetEl.operations.join(',')}`);
  if (freshFp !== decision.fingerprint) {
    return { ok: false, stale: true, fault: 'replaced', reasons: ['TARGET_REPLACED'] };
  }

  if (targetEl.enabled === false) {
    return { ok: false, stale: true, fault: 'disabled', reasons: ['TARGET_DISABLED'] };
  }

  if (coveredRefs.includes(decision.targetRef)) {
    return { ok: false, stale: true, fault: 'covered', reasons: ['TARGET_COVERED'] };
  }

  return { ok: true, stale: false, fault: null, reasons: [] };
}

// Run a shadow browser-step iteration: build request -> invoke injected query -> validate.
// Invariant: Never executes browser actions; outputs shadow audit record.
export async function runShadowBrowserStep(input = {}) {
  const {
    snapshot,
    goal,
    requestId,
    urlOrigin,
    url,
    runId,
    permitId,
    bounds,
    recentActions,
    snapshotCapturedAt,
    ttlMs = DEFAULT_TTL_MS,
    query,
    normalAgentDecision = null,
    postcondition = null,
  } = input;

  if (typeof query !== 'function') {
    throw shadowError('REQUEST_INVALID', 'query must be an injectable async function');
  }

  let capturedAt = null;
  if ('snapshotCapturedAt' in input && input.snapshotCapturedAt !== undefined) {
    if (typeof input.snapshotCapturedAt !== 'number' || !Number.isFinite(input.snapshotCapturedAt)) {
      throw shadowError('REQUEST_INVALID', 'snapshotCapturedAt must be a finite epoch-ms number');
    }
    capturedAt = input.snapshotCapturedAt;
  }
  if (snapshot && typeof snapshot === 'object' && 'capturedAt' in snapshot && snapshot.capturedAt !== undefined) {
    if (typeof snapshot.capturedAt !== 'number' || !Number.isFinite(snapshot.capturedAt)) {
      throw shadowError('REQUEST_INVALID', 'snapshotCapturedAt must be a finite epoch-ms number');
    }
    if (capturedAt === null) {
      capturedAt = snapshot.capturedAt;
    }
  }

  const getTime = typeof input.now === 'function' ? input.now : () => (typeof input.now === 'number' ? input.now : Date.now());

  const t0 = getTime();
  const boundAt = capturedAt ?? t0;
  let built;
  try {
    built = buildBrowserStepRequest({
      snapshot,
      goal,
      requestId,
      urlOrigin,
      url,
      runId,
      permitId,
      bounds,
      recentActions,
    });
  } catch (error) {
    const projectedNormalAgentDecision = projectNormalAgentDecision(normalAgentDecision, { elementRefs: null });
    const projectedPostcondition = projectPostcondition(postcondition);
    return {
      schema: SHADOW_RECORD_SCHEMA,
      requestId: requestId ?? null,
      kind: 'browser-step',
      engine: 'jev-shadow',
      shadow: true,
      executed: false,
      browserActions: 0,
      status: 'fallback-required',
      reason: `BUILD_FAILED:${sanitizeReasonCode(error?.code)}`,
      jevDecision: null,
      normalAgentDecision: projectedNormalAgentDecision,
      agreement: null,
      postcondition: projectedPostcondition,
      snapshotDigest: null,
      questionSetDigest: null,
      snapshotCapturedAt: boundAt,
      lineage: projectLineage(null),
      timing: {
        buildMs: 0,
        validateMs: 0,
        queryMs: 0,
        overheadMs: 0,
        totalMs: 0,
      },
      mcpCalls: { shadow: 0, browserActions: 0 },
      questionCount: 0,
      createdAt: isoOrNull(getTime()),
    };
  }
  const t1 = getTime();
  const buildMs = Math.max(0, t1 - t0);

  const elementRefs = new Set(built.elements.map((e) => e.ref));
  const projectedNormalAgentDecision = projectNormalAgentDecision(normalAgentDecision, { elementRefs });
  const projectedPostcondition = projectPostcondition(postcondition);

  let queryRaw;
  const t2 = getTime();
  try {
    queryRaw = await query(built.request);
  } catch (error) {
    const t3 = getTime();
    const queryMs = Math.max(0, t3 - t2);
    const totalMs = Math.max(0, t3 - t0);

    return {
      schema: SHADOW_RECORD_SCHEMA,
      requestId: built.request.requestId,
      kind: 'browser-step',
      engine: 'jev-shadow',
      shadow: true,
      executed: false,
      browserActions: 0,
      status: 'fallback-required',
      reason: `QUERY_FAILED:${sanitizeReasonCode(error?.code)}`,
      jevDecision: null,
      normalAgentDecision: projectedNormalAgentDecision,
      agreement: null,
      postcondition: projectedPostcondition,
      snapshotDigest: built.snapshotDigest,
      questionSetDigest: built.request.questionSet.digest,
      snapshotCapturedAt: boundAt,
      lineage: projectLineage(null),
      timing: {
        buildMs,
        validateMs: 0,
        queryMs,
        overheadMs: buildMs,
        totalMs,
      },
      mcpCalls: { shadow: 0, browserActions: 0 },
      questionCount: Object.keys(built.request.questions).length,
      createdAt: isoOrNull(getTime()),
    };
  }

  const t3 = getTime();
  const queryMs = Math.max(0, t3 - t2);
  const result = queryRaw && queryRaw.result ? queryRaw.result : queryRaw;

  const t4 = getTime();
  const validation = validateShadowDecision(result, {
    request: built.request,
    elements: built.elements,
    snapshotDigest: built.snapshotDigest,
    boundAt,
    now: getTime(),
    ttlMs,
  });
  const t5 = getTime();
  const validateMs = Math.max(0, t5 - t4);
  const totalMs = Math.max(0, t5 - t0);
  const overheadMs = buildMs + validateMs;

  const jevDecision = {
    operation: validation.decision?.operation ?? null,
    targetRef: validation.decision?.targetRef ?? null,
    confidence: validation.decision?.confidence ?? null,
    snapshotDigest: validation.decision?.snapshotDigest ?? null,
    decidedAt: validation.decision?.decidedAt ?? null,
    fingerprint: validation.decision?.fingerprint ?? null,
    valid: validation.ok,
    invalid: validation.invalid,
    stale: validation.stale,
    actionable: validation.actionable,
    reasons: validation.reasons,
  };

  const isInvalid = validation.invalid === true;
  const status = isInvalid ? 'invalid' : 'ok';
  const reason = isInvalid ? 'INVALID_RESULT' : null;

  let agreement = null;
  if (!isInvalid && jevDecision.actionable && projectedNormalAgentDecision) {
    agreement = (jevDecision.operation === projectedNormalAgentDecision.operation) &&
                (jevDecision.targetRef === (projectedNormalAgentDecision.targetRef ?? null));
  }

  return {
    schema: SHADOW_RECORD_SCHEMA,
    requestId: built.request.requestId,
    kind: 'browser-step',
    engine: 'jev-shadow',
    shadow: true,
    executed: false,
    browserActions: 0,
    status,
    reason,
    jevDecision,
    normalAgentDecision: projectedNormalAgentDecision,
    agreement,
    postcondition: projectedPostcondition,
    snapshotDigest: built.snapshotDigest,
    questionSetDigest: built.request.questionSet.digest,
    snapshotCapturedAt: boundAt,
    lineage: projectLineage(result?.lineage ?? null),
    timing: {
      buildMs,
      validateMs,
      queryMs,
      overheadMs,
      totalMs,
    },
    mcpCalls: { shadow: 0, browserActions: 0 },
    questionCount: Object.keys(built.request.questions).length,
    createdAt: isoOrNull(getTime()),
  };
}
