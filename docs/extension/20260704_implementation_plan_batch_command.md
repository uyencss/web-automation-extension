# Implementation Plan — `batch` Command (Gateway + Extension)

**Date:** 2026-07-04
**Reference:** Claude Chrome Extension `browser_batch` (`REF_CODE/claude-chrome-ext/assets/mcpPermissions-CJK8I7C7.js`)
**Scope:** Gộp nhiều gateway command vào **1 HTTP round-trip**, xử lý phía extension, expose qua `/health` + MCP.
**Status:** Reviewed against actual code (không phải draft lý thuyết). Xem `## Đánh giá bản draft gốc`.

---

## Problem

Khi một agent **điều khiển sống** qua gateway (chưa/không đúc thành workflow JSON), mỗi thao tác là 1 lần `POST /api` riêng. Một kịch bản đơn giản như "gõ prompt vào Gemini → click Send → chờ → đọc kết quả" tốn **5–7 round-trip** gateway↔agent, mỗi round-trip là một lần LLM ra quyết định.

Kit hiện có **hai thái cực**, thiếu lớp ở giữa:

| | Live control (từng lệnh) | Workflow JSON (`webmcp-workflow`) |
|---|---|---|
| Round-trip | N lệnh = N HTTP call | 1 lệnh `run` |
| Chi phí soạn | 0 (ad-hoc) | Phải viết + validate file JSON |
| Phù hợp | Khám phá, one-off | Tác vụ lặp lại, deterministic |
| Điểm yếu | Nhiều round-trip, tốn token/độ trễ | Nặng nề cho việc thử nhanh |

`browser_batch` của Claude extension lấp đúng khoảng giữa này: gộp một *chuỗi thao tác dự đoán trước được* vào 1 lần gọi. WebMCP nên có primitive tương đương — nhưng thiết kế theo kiến trúc JSON-RPC/WebSocket của gateway, **không** thay thế workflow runner (hai thứ bổ trợ nhau).

> **Bối cảnh thực nghiệm:** kế hoạch này bắt nguồn từ test chạy kịch bản Gemini (`gõ → gửi → đọc`). Live control mất ~6 HTTP call; batch gộp còn 1. Kịch bản đó được dùng làm acceptance test ở cuối.

---

## Đánh giá bản draft gốc (verified vs code)

Tôi đã đọc code thật trước khi chốt. Tóm tắt:

### ✅ Các giả định của draft — ĐÚNG

| Giả định trong draft | Xác nhận từ code |
|---|---|
| `dist/bg/handlers/` là source viết tay | Đúng — ES module sạch, không minify. `build/` chỉ chứa `.zip` đóng gói. Sửa trực tiếp `dist/` là đúng. |
| Router dispatch `commandHandlers[method]` | Đúng — `bg/router.js:21`. |
| `command-catalog.js` là nguồn cho cả `/health` và MCP tools | Đúng — gateway (`getGatewayCommandGroups`) và `mcp-tool-catalog.mjs` (`COMMAND_DEFINITIONS`) đều đọc từ đây. |
| Group không phải `runner` sẽ được expose | Đúng — gateway `/health` lọc `group !== 'runner'` (`gateway_server.js:150`), MCP lọc `definition.group !== 'runner'` (`mcp-tool-catalog.mjs:209`). |
| MCP `contentFromResult` chỉ xử lý `base64` top-level | Đúng — `mcp_server.mjs:133`. Screenshot lồng trong `results[i]` cần sửa như draft nêu. |
| `screenshotAfter` mặc định `false` để tiết kiệm | Giữ nguyên — hợp lý. |

### ⚠️ Các điểm draft SAI/THIẾU — đã hiệu đính trong plan này

1. **Circular dependency giải quyết được triệt để hơn.** Draft đề xuất `batch.js` import `commandHandlers` từ `index.js` (lazy). Cách sạch hơn: **inject `commandHandlers` qua `router.js`**, `batch.js` chỉ là **pure function `runBatch(params, handlers)`**. → Zero circular dep, tự động chặn nested batch, dễ unit-test. (Xem D1.)

2. **[GAP LỚN] Thiếu threading `tabId` giữa các action.** Mỗi handler tự `resolveTabId(params)` → mặc định active tab (`utils.js:1`). Trong batch, nếu action 1 là `newTab`/`navigate` rồi action 2 `typeByRef` không có `tabId`, action 2 lại resolve active tab — mong manh khi có nhiều tab. Claude giải quyết bằng cách **bắt buộc `tabId` mỗi action trong batch**. Ta làm tốt hơn: **carry-over tabId** (kế thừa `tabId` từ result của action trước) + `tabId` cấp batch. (Xem D3.)

3. **`delay`/`wait` ĐÃ tồn tại** trong catalog dưới group `runner` (`command-catalog.js:95-96`) — nhưng **không có handler trong extension** (chúng do workflow runner xử lý). Vậy: batch **vẫn phải tự xử lý delay nội bộ** (đúng như draft), nhưng **không đăng ký `delay` catalog mới cho extension**, và đặt tên tham số nhất quán với runner (`ms`/`timeout`).

4. **Bỏ edit `ARRAY_PARAMS += 'actions'`.** Vì batch được special-case schema đầy đủ trong `buildTool`, thêm `actions` vào `ARRAY_PARAMS` là **thừa** (chỉ tạo `{type:'array'}` không có item schema, lại bị special-case ghi đè). Chỉ giữ special-case.

5. **`onError` chỉ 2 mode, không phải 3.** `stop-on-error` **vốn đã** trả partial results (push kết quả rồi mới `break`). Mode thứ ba `stop-on-error-return-partial` là trùng lặp → loại bỏ.

6. **[BỔ SUNG] Per-action timeout.** Một action treo (vd `waitForStable` không settle, `navigate` trang kẹt) sẽ block cả batch tới khi gateway 504 — và batch **vẫn chạy tiếp trong extension** (orphan). Thêm `Promise.race` timeout mỗi action để chỉ action đó fail. (Xem D4.)

7. **[CAVEAT] Sub-result không được auto-unwrap.** Gateway `normalizeResult` (`gateway_server.js:59`) chỉ unwrap page-tool JSON ở **top-level**. Trong batch, kết quả `webmcp.invokeTool` trả raw `{tabId, result:{content:[{text}]}}` — caller phải tự parse. Ghi rõ trong doc; tùy chọn cho batch tự normalize sub-result.

---

## Design Decisions

### D1: `batch` xử lý ở extension, inject handlers qua router (không circular dep)

`batch.js` export **pure function** `runBatch(params, handlers)`. `router.js` (vốn đã import `commandHandlers`) special-case `method === 'batch'` và gọi `runBatch(params, commandHandlers)` **trước** generic dispatch.

**Lý do chọn cách này thay vì nhét `batch` vào `commandHandlers`:**
- **Zero circular dependency** — `batch.js` không import `index.js`. (Draft dùng lazy import cũng chạy được, nhưng inject sạch hơn và không phụ thuộc thứ tự evaluate module.)
- **Chặn nested batch miễn phí** — batch không nằm trong `commandHandlers` nên một action `{method:"batch"}` sẽ không tìm thấy handler (ta vẫn thêm guard tường minh cho chắc).
- **Testable** — `runBatch` test được với `handlers` giả, không cần Chrome.
- **Discoverability không đổi** — `/health` và MCP đọc từ `command-catalog.js`, độc lập với `commandHandlers`. Chỉ cần đăng ký catalog (Component 3).

> Chạy **bên trong extension** → mỗi sub-action là một lời gọi hàm JS trực tiếp, **0 round-trip gateway↔extension**. Đây là điểm ăn tiền chính.

### D2: Schema `{method, params}` — nhất quán với `POST /api`

Mỗi action là `{ method, params }` — **giống hệt** shape body của `/api` và `browser_raw_command`. Agent đã quen shape này; không phát minh cú pháp mới. (Claude dùng `{name, input}` vì tool layer của nó; ta bám convention gateway.)

### D3: Threading `tabId` — carry-over + batch-level default

- `params.tabId` cấp batch (tùy chọn): inject vào **mọi** action không tự khai `tabId`.
- **Carry-over**: sau mỗi action, nếu result có `tabId` (`navigate`/`newTab`/`getActiveTab`/hầu hết handler đều trả), dùng nó làm tab mặc định cho các action sau.

→ Kịch bản "mở tab rồi thao tác" trở nên **deterministic** mà không bắt agent lặp `tabId` ở mọi action. Nếu agent muốn nhắm tab cụ thể vẫn khai `tabId` trong action đó (ghi đè carry-over).

### D4: An toàn — giới hạn + timeout mỗi action

| Giới hạn | Giá trị | Lý do |
|---|---|---|
| Max actions/batch | 50 | Tránh giữ SW bận quá lâu |
| Max delay pseudo-action | 10s | Chống abuse |
| Per-action timeout | `actionTimeoutMs` (mặc định 60s) | 1 action treo không kéo sập cả batch |
| Nested batch | Từ chối | Chống đệ quy/fan-out |

Gateway cấp timeout **tỉ lệ** cho request batch: `min(COMMAND_TIMEOUT_MS × actionCount, 300000)`. (`navigate`/`newTab` vốn tự cap 30s nội bộ — `tab-management.js:34`.)

### D5: Không thay thế workflow runner

`batch` = sequencing **ad-hoc, sống, agent-driven, 1 round-trip**. `webmcp-workflow` JSON = replay **deterministic, lưu trữ, có verify/history**. Batch giúp pha "khám phá" nhanh hơn và là *nguyên liệu* để sau đúc thành workflow.

---

## Proposed Changes

### Component 1 — Batch handler (pure function)

#### [NEW] `webmcp-extension/dist/bg/handlers/batch.js`

```javascript
// bg/handlers/batch.js
// Pure orchestration helper: runs a sequence of gateway commands in-process.
// Injected with the resolved `commandHandlers` map by router.js (no circular import).

const MAX_ACTIONS = 50;
const MAX_DELAY_MS = 10_000;
const DEFAULT_ACTION_TIMEOUT_MS = 60_000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`batch action timed out after ${ms}ms: ${label}`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {Object} params
 * @param {Array<{method:string, params?:object}>} params.actions
 * @param {'continue'|'stop-on-error'} [params.onError='continue']
 * @param {boolean} [params.screenshotAfter=false]  chụp ảnh sau MỖI action
 * @param {number}  [params.tabId]                  tab mặc định cho mọi action
 * @param {number}  [params.actionTimeoutMs=60000]  timeout mỗi action
 * @param {Object}  handlers  the resolved commandHandlers map (injected)
 * @returns {{total,executed,success,errors,results:Array}}
 */
export async function runBatch(params, handlers) {
  const {
    actions,
    onError = 'continue',
    screenshotAfter = false,
    tabId: batchTabId,
    actionTimeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
  } = params || {};

  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error('batch: "actions" must be a non-empty array');
  }
  if (actions.length > MAX_ACTIONS) {
    throw new Error(`batch: too many actions (${actions.length} > ${MAX_ACTIONS})`);
  }

  const results = [];
  let success = 0;
  let errors = 0;
  let carryTabId = batchTabId; // last known tab, threaded across actions (D3)

  const fail = (i, method, error) => {
    results.push({ index: i, method, ok: false, error, duration: 0 });
    errors++;
  };

  for (let i = 0; i < actions.length; i++) {
    const { method, params: p = {} } = actions[i] || {};

    // Guard: no nested batch (D4)
    if (method === 'batch') {
      fail(i, method, 'nested batch is not allowed');
      if (onError === 'stop-on-error') break;
      continue;
    }

    // delay / wait pseudo-actions — extension has no such handler; mirror the
    // runner's `wait`/`delay` (command-catalog.js group "runner").
    if (method === 'delay' || method === 'wait') {
      const ms = Math.min(Number(p.ms ?? p.timeout ?? 500) || 0, MAX_DELAY_MS);
      await new Promise((r) => setTimeout(r, ms));
      results.push({ index: i, method, ok: true, result: { waited: ms }, duration: ms });
      success++;
      continue;
    }

    const handler = handlers[method];
    if (typeof handler !== 'function') {
      fail(i, method, `unknown method: "${method}"`);
      if (onError === 'stop-on-error') break;
      continue;
    }

    // Thread tabId: inject carried tab when the action didn't name one (D3).
    const actionParams =
      carryTabId != null && p.tabId === undefined ? { ...p, tabId: carryTabId } : p;

    const t0 = Date.now();
    try {
      const result = await withTimeout(
        Promise.resolve(handler(actionParams)),
        actionTimeoutMs,
        method,
      );
      const entry = { index: i, method, ok: true, result, duration: Date.now() - t0 };

      // Carry forward whatever tab this action resolved/created.
      if (result && typeof result.tabId === 'number') carryTabId = result.tabId;

      // Inline screenshot: from the action itself, or captured on request.
      if (result && typeof result.base64 === 'string') {
        entry.screenshot = { base64: result.base64, format: result.format || 'png' };
      } else if (screenshotAfter && typeof handlers.screenshot === 'function') {
        try {
          const snap = await handlers.screenshot(carryTabId != null ? { tabId: carryTabId } : {});
          entry.screenshot = { base64: snap.base64, format: snap.format || 'png' };
        } catch {
          /* best-effort — a failed screenshot must not fail the action */
        }
      }

      results.push(entry);
      success++;
    } catch (err) {
      results.push({
        index: i,
        method,
        ok: false,
        error: err?.message || String(err),
        duration: Date.now() - t0,
      });
      errors++;
      if (onError === 'stop-on-error') break;
    }
  }

  return { total: actions.length, executed: results.length, success, errors, results };
}
```

**Điểm thiết kế:**
- Pure function, không import gì từ `index.js` → không circular dep.
- Mỗi entry có `ok` + `duration` → agent biết chính xác bước nào fail và mất bao lâu.
- tabId carry-over (D3) làm chuỗi multi-tab deterministic.
- Per-action `withTimeout` (D4) cô lập action treo.
- `delay`/`wait` nội bộ (extension không có handler cho chúng).

---

### Component 2 — Router special-case

#### [MODIFY] `webmcp-extension/dist/bg/router.js`

```diff
 import { sendResult, sendError, sendNotification } from './ws-client.js';
 import { commandHandlers } from './handlers/index.js';
+import { runBatch } from './handlers/batch.js';

 export async function handleIncomingMessage(msg) {
   if (!('method' in msg)) return;

   if (msg.id === undefined) {
     if (msg.method === 'ping') {
       sendNotification('pong', { ts: Date.now() });
       return;
     }
     console.log('[WS] Notification:', msg.method, msg.params);
     return;
   }

+  // Orchestration primitive: run several commands in-process, one round-trip.
+  // Handled before the generic dispatch so it never needs to live in
+  // commandHandlers (avoids circular import + nested-batch recursion).
+  if (msg.method === 'batch') {
+    try {
+      const result = await runBatch(msg.params || {}, commandHandlers);
+      sendResult(msg.id, result);
+    } catch (err) {
+      sendError(msg.id, -1, err.message || String(err));
+    }
+    return;
+  }
+
   const handler = commandHandlers[msg.method];
   if (!handler) {
     sendError(msg.id, -32601, await methodNotFoundHint(msg.method));
     return;
   }
   ...
```

> `handlers/index.js` **không cần đổi** — batch không nằm trong `commandHandlers`.

---

### Component 3 — Catalog registration (discoverability + MCP)

#### [MODIFY] `catalog/command-catalog.js`

Thêm group `orchestration` và định nghĩa `batch`:

```diff
 const COMMAND_GROUPS = [
   { id: 'tabs', label: 'Tab management' },
   { id: 'page', label: 'Page interaction' },
+  { id: 'orchestration', label: 'Multi-action orchestration' },
   { id: 'cdp', label: 'Chrome DevTools Protocol' },
   ...
   { id: 'runner', label: 'Runner pseudo commands' },
 ];
```

```diff
 const COMMAND_DEFINITIONS = [
+  ['batch', {
+    group: 'orchestration',
+    description:
+      'Execute several gateway commands sequentially in ONE round-trip. Each ' +
+      'action is { method, params } matching any gateway command (navigate, ' +
+      'clickByRef, typeByRef, getPageText, screenshot, waitForStable, or the ' +
+      'delay/wait pseudo-action). Threads tabId across actions (carry-over from ' +
+      'each result; batch-level tabId as default). onError="stop-on-error" halts ' +
+      'on first failure (partial results returned); "continue" (default) runs all. ' +
+      'screenshotAfter=true captures a screenshot after every action. Returns ' +
+      '{ total, executed, success, errors, results:[{index,method,ok,result?,error?,duration,screenshot?}] }.',
+    requiredParams: ['actions'],
+    optionalParams: ['onError', 'screenshotAfter', 'tabId', 'actionTimeoutMs'],
+  }],
   ['listTabs', { group: 'tabs' }],
   ...
```

> Vì group `orchestration` ≠ `runner`, `batch` tự động xuất hiện trong `/health` (`gateway_server.js:150`) và trong MCP tool list (`mcp-tool-catalog.mjs:209`). Vì `batch` **không** nằm trong `MINIMAL_HIDDEN_METHODS`, nó hiện mặc định trên minimal surface — đúng mong muốn (batch là high-value).

---

### Component 4 — Gateway timeout tỉ lệ cho batch

#### [MODIFY] `server/gateway_server.js` (POST `/api`, quanh dòng 224)

```diff
-      // Set up a timeout for this request
-      const timeoutTimer = setTimeout(() => {
+      // Batch runs several commands sequentially → longer, proportional timeout.
+      const actionCount =
+        method === 'batch' && Array.isArray(params?.actions) ? params.actions.length : 1;
+      const effectiveTimeout = Math.min(COMMAND_TIMEOUT_MS * actionCount, 300_000);
+      const timeoutTimer = setTimeout(() => {
         const pending = pendingHttpRequests.get(rpcId);
         if (pending) {
           pendingHttpRequests.delete(rpcId);
           writeJson(
             pending.res,
             504,
-            { error: `Command '${method}' timed out after ${COMMAND_TIMEOUT_MS}ms` }
+            { error: `Command '${method}' timed out after ${effectiveTimeout}ms` }
           );
         }
-      }, COMMAND_TIMEOUT_MS);
+      }, effectiveTimeout);
```

> Cap cứng 300s. `WEBMCP_GATEWAY_TIMEOUT_MS` vẫn điều chỉnh được base. Per-action timeout của batch (D4) là lớp phòng thủ đầu; gateway 504 là lớp cuối.

---

### Component 5 — MCP tool schema (nested actions)

#### [MODIFY] `server/mcp-tool-catalog.mjs`

Special-case `batch` trong `buildTool` (schema lồng chính xác). **KHÔNG** thêm `actions` vào `ARRAY_PARAMS` (thừa — special-case đã ghi đè).

```diff
 function buildTool(method, definition) {
   const requiredParams = definition.requiredParams || [];
   const optionalParams = definition.optionalParams || [];
   const group = definition.group || 'control';

+  // batch has a nested action schema that the generic builder can't express.
+  if (method === 'batch') {
+    return {
+      name: 'batch',
+      method: 'batch',
+      group,
+      description: definition.description,
+      inputSchema: {
+        type: 'object',
+        properties: {
+          actions: {
+            type: 'array',
+            description: 'Ordered commands to run sequentially.',
+            items: {
+              type: 'object',
+              properties: {
+                method: {
+                  type: 'string',
+                  description:
+                    'Gateway command name (navigate, clickByRef, typeByRef, ' +
+                    'getPageText, screenshot, waitForStable, delay, ...).',
+                },
+                params: { type: 'object', additionalProperties: true },
+              },
+              required: ['method'],
+              additionalProperties: false,
+            },
+          },
+          onError: { type: 'string', enum: ['continue', 'stop-on-error'] },
+          screenshotAfter: { type: 'boolean' },
+          tabId: { type: 'number', description: 'Default tab for every action.' },
+          actionTimeoutMs: { type: 'number' },
+          profileId: {
+            type: 'string',
+            description: 'Route to this Chrome profile when several are connected.',
+          },
+        },
+        required: ['actions'],
+        additionalProperties: false,
+      },
+    };
+  }

   return {
     name: toolNameForMethod(method),
     method,
     group,
     description: TOOL_DESCRIPTIONS[method] ||
       `${definition.description || method} gateway command (${group}).`,
     inputSchema: buildInputSchema(requiredParams, optionalParams),
   };
 }
```

> `profileId` phải khai tay ở đây vì special-case **không** đi qua `buildInputSchema` (chỗ vốn tự thêm `profileId`, `mcp-tool-catalog.mjs:82`).

---

### Component 6 — MCP result rendering (per-action screenshots)

#### [MODIFY] `server/mcp_server.mjs` — `contentFromResult` (dòng 133)

```diff
 function contentFromResult(result) {
+  // Batch result: flatten per-action outcomes, interleave any screenshots.
+  if (
+    result && typeof result === 'object' &&
+    Array.isArray(result.results) && typeof result.total === 'number'
+  ) {
+    const content = [{
+      type: 'text',
+      text: `Batch: ${result.success}/${result.total} ok, ${result.errors} error(s), ${result.executed} executed`,
+    }];
+    for (const item of result.results) {
+      const status = item.ok ? '✓' : `✗ ${item.error}`;
+      const body = item.ok && item.result
+        ? '\n' + JSON.stringify(item.result, null, 2) : '';
+      content.push({
+        type: 'text',
+        text: `[${item.index}] ${item.method} ${status} (${item.duration}ms)${body}`,
+      });
+      if (item.screenshot?.base64) {
+        content.push({
+          type: 'image',
+          data: item.screenshot.base64,
+          mimeType: `image/${item.screenshot.format || 'png'}`,
+        });
+      }
+    }
+    return content;
+  }
+
   if (result && typeof result === 'object' && typeof result.base64 === 'string') {
```

> Discriminator `Array.isArray(result.results) && typeof result.total === 'number'` khớp đúng shape trả về của `runBatch`, không đụng các result khác.

**profileId đã đúng sẵn:** trong `mcp_server.mjs:183-185`, với tool có `tool.method` (batch có), code làm `params = {...args}; delete params.profileId;` rồi `callGateway(method, params, args.profileId)` → `profileId` được nâng lên top-level body. Không cần sửa thêm.

---

## Caveats (ghi rõ để người dùng biết trade-off)

1. **Sub-result KHÔNG được auto-unwrap.** Gateway `normalizeResult` chỉ unwrap page-tool JSON ở top-level. Một `webmcp.invokeTool` **trong** batch trả raw `{tabId, result:{content:[{text}]}}` — caller tự `JSON.parse(results[i].result.result.content[0].text)`. *(Tùy chọn nâng cấp: cho `runBatch` áp cùng logic normalize lên sub-result để đồng nhất — chưa đưa vào bản này để giữ surgical.)*
2. **`screenshotAfter` tốn payload.** Nhiều base64 trong 1 response làm phình JSON gateway lẫn context MCP. Khuyến nghị: để mặc định `false`, chèn action `screenshot` tại vài checkpoint thay vì bật `screenshotAfter` cho batch dài.
3. **Batch không đổi mô hình bảo mật.** Nó chỉ *tuần tự hóa* các command đã có (gồm `evaluateJS`/`executeCDP`/cookies). Vẫn áp nguyên tắc gateway: bind `localhost`, chỉ chạy input tin cậy. Không mở rộng attack surface.
4. **1 batch = 1 profile.** `profileId` ở cấp request; mọi sub-action chạy trên cùng profile đó (đúng mong muốn).

---

## Ví dụ sử dụng

### VD1 — Kịch bản Gemini gộp thành 1 HTTP call

```bash
curl -X POST http://localhost:7865/api -H 'Content-Type: application/json' -d '{
  "method": "batch",
  "profileId": "477e66b8-5617-4bd1-8aec-c85be081e20c",
  "params": {
    "onError": "stop-on-error",
    "actions": [
      { "method": "getAriaSnapshot", "params": { "maxNodes": 60 } },
      { "method": "typeByRef",  "params": { "ref": "r32", "text": "Xin chào từ batch!" } },
      { "method": "clickByRef", "params": { "ref": "r37" } },
      { "method": "delay",      "params": { "ms": 4000 } },
      { "method": "getPageText","params": { "maxLength": 1200 } }
    ]
  }
}'
```

### VD2 — MCP tool call từ agent

```json
{
  "name": "batch",
  "arguments": {
    "onError": "continue",
    "actions": [
      { "method": "navigate", "params": { "url": "https://example.com" } },
      { "method": "waitForStable", "params": {} },
      { "method": "getAriaSnapshot", "params": {} },
      { "method": "screenshot", "params": {} }
    ]
  }
}
```

### VD3 — Trước/sau

```
TRƯỚC: navigate → waitForStable → typeByRef → clickByRef → delay → getPageText   (6 HTTP calls, 6 lượt LLM)
SAU:   batch(6 actions)                                                          (1 HTTP call, 1 lượt LLM)
```

---

## Open Questions (đã chốt đề xuất, chờ xác nhận)

1. **Tên tool:** `batch` (bám convention bare-method của gateway) thay vì `browser_batch`. → Đề xuất: **`batch`**.
2. **Auto-normalize sub-result** (Caveat 1): làm luôn hay để caller tự parse? → Đề xuất: **để caller tự parse** ở bản đầu (surgical), thêm sau nếu cần.
3. **Cap số screenshot** khi `screenshotAfter=true`: có nên giới hạn (vd 10 ảnh) không? → Đề xuất: **chưa cap**, chỉ document; theo dõi thực tế.

---

## Verification Plan

### Automated
```bash
# 1) batch xuất hiện trong /health
curl -s http://localhost:7865/health | jq '.commands[] | select(.name=="batch")'

# 2) batch cơ bản — 3 read-only actions
curl -sX POST http://localhost:7865/api -H 'Content-Type: application/json' -d '{
  "method":"batch","params":{"actions":[
    {"method":"getActiveTab","params":{}},
    {"method":"listTabs","params":{}},
    {"method":"screenshot","params":{}}
  ]}}' | jq '{total,success,errors}'

# 3) stop-on-error dừng đúng chỗ, trả partial
curl -sX POST http://localhost:7865/api -H 'Content-Type: application/json' -d '{
  "method":"batch","params":{"onError":"stop-on-error","actions":[
    {"method":"getActiveTab","params":{}},
    {"method":"nonExistentMethod","params":{}},
    {"method":"screenshot","params":{}}
  ]}}' | jq '{executed,errors, methods:[.results[].method]}'
# kỳ vọng: executed=2 (dừng sau lỗi), screenshot không chạy

# 4) nested batch bị từ chối
curl -sX POST http://localhost:7865/api -H 'Content-Type: application/json' -d '{
  "method":"batch","params":{"actions":[{"method":"batch","params":{"actions":[]}}]}}' \
  | jq '.result.results[0]'
```

### Unit test (pure function)
`tests/` — test `runBatch(params, fakeHandlers)`:
- carry-over `tabId`: action 1 trả `{tabId:99}`; action 2 không khai `tabId` → nhận `tabId:99`.
- `onError`: `continue` chạy hết; `stop-on-error` break và trả partial.
- per-action timeout: handler treo → chỉ action đó `ok:false`, batch tiếp tục (mode continue).
- delay pseudo-action bị cap 10s.

### Manual / E2E (acceptance)
- **Kịch bản Gemini** (VD1) end-to-end: 1 batch → `results[].getPageText` chứa câu trả lời của Gemini. Đây là bài test tái hiện đúng động cơ của tính năng.
- MCP: gọi tool `batch` từ agent thật, kiểm tra `content[]` có text per-action + image interleaved đúng thứ tự.
- Latency: so sánh batch(5) vs 5 lần `/api` tuần tự.

### Rebuild extension
Sau khi sửa `dist/`, đóng gói lại `webmcp-extension/build/webmcp-extension-vX.Y.Z.zip` và bump version (theo pattern các zip đang có: `v2.1.8` → tiếp theo). Reload unpacked để test local.
