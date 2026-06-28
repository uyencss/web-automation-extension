// ============================================================
// Shared in-page DOM helpers (Shadow DOM piercing)
//
// Exported as a JS-source STRING so it can be interpolated into the
// expressions sent to Runtime.evaluate by the DOM-reading handlers.
//
// querySelectorAll and TreeWalker do NOT cross shadow boundaries. On
// Web-Component-heavy sites (YouTube/Polymer, design systems) elements live
// inside OPEN shadow roots. These helpers recurse into open shadow roots.
//
// Hard limit: closed shadow roots (attachShadow({mode:'closed'})) expose
// el.shadowRoot === null and cannot be traversed from page JS by anyone.
// ============================================================

export const DOM_DEEP_HELPERS = `
function __webmcpQueryDeep(selector, root) {
  root = root || document;
  const results = [];
  const seen = new Set();
  function walk(node) {
    let matches;
    try { matches = node.querySelectorAll(selector); } catch (e) { matches = []; }
    for (const el of matches) {
      if (!seen.has(el)) { seen.add(el); results.push(el); }
    }
    // Descend into open shadow roots hosted within this root
    let all;
    try { all = node.querySelectorAll('*'); } catch (e) { all = []; }
    for (const el of all) {
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  }
  walk(root);
  return results;
}

function __webmcpWalkTextDeep(root, visit) {
  root = root || document.body;
  function walk(node) {
    const tw = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = tw.nextNode())) visit(n);
    // Recurse into open shadow roots (separate trees TreeWalker won't enter)
    let all;
    try { all = node.querySelectorAll ? node.querySelectorAll('*') : []; } catch (e) { all = []; }
    for (const el of all) {
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  }
  walk(root);
}
`;
