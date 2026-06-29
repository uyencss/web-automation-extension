// Builds the in-page expression for smart "readable text" extraction used by
// the getPageText / readPage handlers.
//
// Modeled on the experience of Claude's get_page_text but kept inside the
// existing CDP evaluate path — no extra permissions, no second execution model.
// We probe a priority list of semantic content containers, choose the candidate
// with the most text (more robust than "first selector wins", which can latch
// onto a tiny related-article card), normalize whitespace, and paginate. Falls
// back to <body> when nothing semantic clearly dominates (SPAs, feeds, etc.).
//
// This module is dependency-free (no `chrome`, no DOM) so the expression logic
// can be unit-tested under Node — see tests/unit/page-text-extraction.test.mjs.
//
// Note on escaping: the returned string is evaluated *in the page*, so regex
// backslashes are doubled here (`\\s`, `\\n`) — the page must receive `\s`,
// `\n`, not literal whitespace.
export function buildTextExtractionExpr(maxLength, offset) {
  return `
    (() => {
      const SELECTORS = [
        'article', 'main',
        '[class*="articleBody"]', '[class*="article-body"]',
        '[class*="post-content"]', '[class*="entry-content"]',
        '[class*="content-body"]', '[role="main"]',
        '.content', '#content'
      ];
      const maxLength = ${Number(maxLength)};
      const offset = ${Number(offset)};

      const textLen = (el) => (el && el.innerText ? el.innerText.length : 0);

      let best = null;
      let bestSource = 'body';
      let bestLen = 0;
      for (const sel of SELECTORS) {
        let nodes;
        try { nodes = document.querySelectorAll(sel); } catch (e) { continue; }
        for (const el of nodes) {
          const len = textLen(el);
          if (len > bestLen) { bestLen = len; best = el; bestSource = sel; }
        }
      }
      if (!best || bestLen < (textLen(document.body) * 0.5)) {
        // Nothing semantic clearly dominates — use the whole body.
        if (!best || textLen(document.body) > bestLen) {
          best = document.body;
          bestSource = 'body';
        }
      }

      const raw = ((best && best.innerText) || '')
        .replace(/[^\\S\\n]+/g, ' ')
        .replace(/ ?\\n ?/g, '\\n')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();

      const base = { title: document.title, url: location.href, source: bestSource };
      if (!raw || raw.length < 10) {
        return { ...base, text: '', totalLength: raw.length, truncated: false, error: 'No readable text content found' };
      }

      const total = raw.length;
      const text = raw.slice(offset, offset + maxLength);
      const end = offset + text.length;
      return {
        ...base,
        text,
        totalLength: total,
        offset,
        returnedLength: text.length,
        truncated: end < total,
        nextOffset: end < total ? end : null,
      };
    })()
  `;
}
