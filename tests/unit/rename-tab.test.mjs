import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTool } from '../../server/gateway/verifier.mjs';
import commandCatalogPkg from '../../catalog/command-catalog.js';
const { getCommand, hasCommand } = commandCatalogPkg;

test('verifier and catalog know renameTab command', () => {
  // Verifier classify
  assert.equal(
    classifyTool('browser_raw_command', { method: 'renameTab' }),
    'browser.raw.renameTab'
  );

  // Command catalog entry
  assert.ok(hasCommand('renameTab'), 'renameTab exists in COMMAND_CATALOG');
  const spec = getCommand('renameTab');
  assert.equal(spec.group, 'tabs');
  assert.deepEqual(spec.optionalParams, ['tabId', 'title']);
});

test('tabHandlers renameTab and listTabs work with chrome storage session', async () => {
  const sessionStorage = new Map();
  const tabsList = [
    { id: 101, url: 'https://example.com/1', title: 'Original Page 1', active: true, windowId: 1 },
    { id: 102, url: 'https://example.com/2', title: 'Original Page 2', active: false, windowId: 1 },
  ];

  // Set up global chrome mock
  globalThis.chrome = {
    debugger: {
      onDetach: { addListener() {} },
      onEvent: { addListener() {} },
    },
    storage: {
      session: {
        async get(keys) {
          if (keys === null) {
            return Object.fromEntries(sessionStorage.entries());
          }
          if (typeof keys === 'string') {
            return sessionStorage.has(keys) ? { [keys]: sessionStorage.get(keys) } : {};
          }
          return {};
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) {
            sessionStorage.set(k, v);
          }
        },
        async remove(key) {
          sessionStorage.delete(key);
        },
      },
    },
    tabs: {
      async query() {
        return [...tabsList];
      },
      async get(id) {
        return tabsList.find((t) => t.id === id);
      },
      async sendMessage(tabId, message, options) {
        return { ok: true, title: message.title || tabsList.find((t) => t.id === tabId)?.title };
      },
    },
  };

  const { tabHandlers } = await import('../../webmcp-extension/dist/bg/handlers/tab-management.js');

  // Initial listTabs: no customTitle
  const initial = await tabHandlers.listTabs();
  assert.equal(initial.tabs.length, 2);
  assert.equal(initial.tabs[0].customTitle, undefined);

  // Rename tab 101
  const renameResult = await tabHandlers.renameTab({ tabId: 101, title: 'Renamed #1' });
  assert.equal(renameResult.tabId, 101);
  assert.equal(renameResult.customTitle, 'Renamed #1');
  assert.equal(renameResult.applied, true);

  // listTabs now includes customTitle for tab 101
  const afterRename = await tabHandlers.listTabs();
  assert.equal(afterRename.tabs[0].customTitle, 'Renamed #1');
  assert.equal(afterRename.tabs[1].customTitle, undefined);

  // Rename tab 101 with long title (should truncate to 256 chars)
  const longTitle = 'A'.repeat(300);
  const longResult = await tabHandlers.renameTab({ tabId: 101, title: longTitle });
  assert.equal(longResult.customTitle.length, 256);
  assert.equal(longResult.customTitle, 'A'.repeat(256));

  // Reset title
  const resetResult = await tabHandlers.renameTab({ tabId: 101, title: '' });
  assert.equal(resetResult.customTitle, null);

  // listTabs no longer has customTitle for tab 101
  const afterReset = await tabHandlers.listTabs();
  assert.equal(afterReset.tabs[0].customTitle, undefined);
});
