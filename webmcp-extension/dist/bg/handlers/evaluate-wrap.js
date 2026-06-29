// Smart wrapping for user code passed to `evaluateJS`.
//
// WebMCP runs the supplied snippet inside an async IIFE — `(async () => { CODE })()`
// — so authors get `await` and `return` for free. The downside of running CODE
// as a *statement body* is that a bare expression or a nested IIFE without an
// outer `return` resolves to `undefined`: the well-known "I ran evaluateJS and
// only got tabId back" gotcha.
//
// wrapEvaluateCode() fixes that by detecting when the snippet is a single
// expression and auto-`return`ing it, while leaving genuine multi-statement
// bodies (declarations, control flow, explicit `return`) untouched.
//
// This module is intentionally dependency-free (no `chrome`, no DOM) so it can
// be unit-tested under Node — see tests/unit/evaluate-wrap.test.mjs.

// Scan `code` at brace/paren/bracket depth 0, skipping strings, template
// literals, and comments, so semicolons or keywords *inside* nested scopes,
// strings, or `${...}` interpolations don't get mistaken for top-level ones.
function analyzeTopLevel(code) {
  let depth = 0;
  let hasTopLevelSemicolon = false;
  let topLevelText = '';
  const n = code.length;
  let i = 0;
  while (i < n) {
    const ch = code[i];
    const next = code[i + 1];

    // Line comment
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && code[i] !== '\n') i++;
      continue;
    }
    // Block comment
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // String / template literal (with nested ${...} handling)
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < n) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === quote) { i++; break; }
        if (quote === '`' && code[i] === '$' && code[i + 1] === '{') {
          let brace = 1;
          i += 2;
          while (i < n && brace > 0) {
            if (code[i] === '{') brace++;
            else if (code[i] === '}') brace--;
            i++;
          }
          continue;
        }
        i++;
      }
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
    } else if (depth === 0) {
      if (ch === ';') hasTopLevelSemicolon = true;
      topLevelText += ch;
    }
    i++;
  }
  return { hasTopLevelSemicolon, topLevelText };
}

// Keywords that signal a statement body rather than a single expression. If any
// appear at depth 0 we leave the author to manage the return value themselves.
const STATEMENT_KEYWORD =
  /(^|[^.\w$])(return|const|let|var|if|for|while|do|switch|throw|try|function|class|debugger|import|export)(?![\w$])/;

export function wrapEvaluateCode(rawCode) {
  const code = String(rawCode);
  // Drop trailing semicolons/whitespace so `document.title;` still reads as a
  // single expression.
  const trimmed = code.trim().replace(/;+\s*$/, '');
  if (!trimmed) return `(async () => { ${code} })()`;

  const { hasTopLevelSemicolon, topLevelText } = analyzeTopLevel(trimmed);
  const isSingleExpression =
    !hasTopLevelSemicolon && !STATEMENT_KEYWORD.test(topLevelText);

  if (isSingleExpression) {
    // Wrap in parens so an object literal (`{a:1}`) isn't parsed as a block.
    return `(async () => { return (\n${trimmed}\n); })()`;
  }
  return `(async () => { ${code} })()`;
}
