# Implementation Plan — Web-Automation-Extension

> Phần phân tích & so sánh 3 extension đã tách sang
> [`extension/evaluation-vs-browser-mcp-codex.md`](extension/evaluation-vs-browser-mcp-codex.md).
> File này chỉ chứa **kế hoạch hành động**.

## Nguyên tắc định hướng

Sản phẩm này là **automation kit phân phối qua npm**, do **AI agent** điều khiển qua
WS localhost — KHÔNG phải browser companion có human-in-the-loop. Mọi tính năng đều phải
trả lời được: _"điều này phục vụ AI agent điều khiển trình duyệt, hay chỉ đánh bóng cho
người quan sát?"_. Giữ kiến trúc tối giản, modular, readable.

---

## ✅ Phase 1 — Reliability tương tác (ĐÃ HOÀN THÀNH)

Đã triển khai (commit chưa push). Đây là phần đóng đúng khoảng cách quan trọng nhất với
Browser-MCP / Codex.

| Hạng mục                                                                                                          | File                                                                    |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| ARIA snapshot + ref-based interaction (`getAriaSnapshot`, `clickByRef`, `typeByRef`, `hoverByRef`, `selectByRef`) | `webmcp-extension/dist/bg/handlers/aria-snapshot.js`                    |
| Page stability + auto-wait sau `click`/`type` (`waitForStable`)                                                   | `webmcp-extension/dist/bg/handlers/page-stability.js`, `high-level.js`  |
| Alarm-based reconnect + exponential backoff                                                                       | `webmcp-extension/dist/bg/ws-client.js`                                 |
| Chrome Alarms keepalive (thay `setInterval`)                                                                      | `webmcp-extension/dist/background.js`                                   |
| CSP hardening (`content_security_policy`)                                                                         | `webmcp-extension/dist/manifest.json`                                   |
| Catalog + skill docs cập nhật                                                                                     | `catalog/command-catalog.js`, `server/mcp-tool-catalog.mjs`, `skills/…` |

**Còn lại cho Phase 1:** verify + commit (xem [Verification](#verification)).

---

## 🟢 Phase 2 — Hai việc thực sự đáng làm

### 2.1 Popup status (chỉ chẩn đoán kết nối)

**Vấn đề:** Khi gateway không kết nối, user không có tín hiệu nào để chẩn đoán.

**Phạm vi — cố tình tối giản (KHÔNG làm settings/command-log):**

- Hiển thị: Gateway `✓/✗`, WS state (connecting / connected / reconnecting), tab đang active,
  số reconnect attempt gần nhất.
- Read-only. Lấy state từ background qua `chrome.runtime.sendMessage`.

**Files:**

- `webmcp-extension/dist/popup/popup.html` — markup tĩnh (tuân thủ CSP: không inline script)
- `webmcp-extension/dist/popup/popup.js` — query state, render
- `webmcp-extension/dist/manifest.json` — thêm `"action": { "default_popup": "popup/popup.html" }`
- `webmcp-extension/dist/background.js` — thêm message handler `getStatus` trả về
  `{ wsState, gatewayUrl, activeTabId, reconnectAttempt }`

**Acceptance:** Mở popup khi gateway tắt → hiện `✗`; bật gateway → tự chuyển `✓` trong vài giây.

### 2.2 WS security hardening (thay cho Native Messaging)

**Vấn đề:** WS bind `ws://localhost:7865`, không có auth — bất kỳ process local nào cũng nối được.

**Phạm vi:**

- Gateway server **bind `127.0.0.1`** (không phải `0.0.0.0`/`localhost` mơ hồ).
- **Shared token** trong handshake: gateway sinh token lúc khởi động, ghi ra file
  (vd `~/.webmcp/token`); extension đọc token (qua popup/storage hoặc config) và gửi kèm
  khi connect; gateway từ chối connection không có token đúng.
- Origin check: từ chối WS upgrade từ origin không mong đợi (chống DNS-rebinding).

**Files:**

- `server/mcp_server.mjs` (và file gateway tương ứng) — bind 127.0.0.1, token gen + verify, origin check
- `webmcp-extension/dist/bg/ws-client.js` — gửi token trong handshake/first message
- Doc cài đặt: mô tả cách extension lấy token

**Acceptance:** Connection không token → bị từ chối; connection đúng token → hoạt động bình thường.

> [!NOTE]
> Đây là lựa chọn thay thế Native Messaging: rẻ hơn nhiều, giữ được mô hình phân phối
> `npx … mcp` một lệnh, đạt ~80% lợi ích bảo mật.

---

## 🟡 Phase 3 — Optional (chỉ làm khi có nhu cầu cụ thể)

### 3.1 History / Bookmarks / TopSites

Mở rộng capability thật (AI tìm "bài báo tuần trước"), low-effort, additive, không đụng
kiến trúc. **Nhưng** thêm permission nhạy cảm về privacy.

→ Chỉ triển khai khi xuất hiện task cần browsing-context. Khi làm:

- Permissions: `"history"`, `"bookmarks"`, `"topSites"`
- Handlers: `searchHistory`, `getBookmarks`, `getTopSites`
- Cập nhật `command-catalog.js` + skill docs

---

## ❌ Đã loại khỏi kế hoạch (không khớp sản phẩm)

Giữ lại đây để khỏi đề xuất lại; chỉ kích hoạt nếu bối cảnh sản phẩm thay đổi.

| Tính năng                        | Điều kiện kích hoạt lại (nếu có)                            |
| -------------------------------- | ----------------------------------------------------------- |
| Visual cursor overlay            | Nếu thêm chế độ human-in-the-loop / demo                    |
| Favicon badge                    | Như trên                                                    |
| Session management / tab leasing | Khi có **nhiều agent điều khiển cùng một Chrome đồng thời** |
| Graceful update lifecycle        | Nếu phân phối qua Chrome Web Store với auto-update          |
| Tab Groups                       | Đi kèm session management                                   |
| Notifications                    | (không) — dư thừa với kênh MCP                              |
| Native Messaging transport       | (không) — đã thay bằng WS hardening                         |

---

## Verification

### Automated

```bash
node server/mcp_server.mjs &      # MCP server khởi động OK
npm run health                    # gateway health
npm run tools:check               # tool catalog sync
```

### Manual (Phase 1 — làm trước khi commit)

- Load extension vào Chrome, kiểm tra connect tới gateway.
- `getAriaSnapshot` trên 1 SPA + 1 trang static → có ref IDs hợp lệ.
- `clickByRef` / `typeByRef` bằng ref vừa lấy → tương tác đúng element.
- Page stability: click element làm load nội dung động → action kế tiếp đợi DOM ổn định.
- Reconnect: restart gateway → extension tự nối lại (exponential backoff, không spam).
- Keepalive: để idle > 60s → service worker không chết, heartbeat vẫn chạy.

### Manual (Phase 2)

- Popup phản ánh đúng trạng thái khi bật/tắt gateway.
- WS từ chối connection sai/không token; chấp nhận token đúng.

---

## Tóm tắt ưu tiên

| Ưu tiên | Việc                                                               | Trạng thái                | Effort  |
| ------- | ------------------------------------------------------------------ | ------------------------- | ------- |
| ✅      | Phase 1 — reliability (ARIA, stability, reconnect, keepalive, CSP) | Done, cần verify + commit | —       |
| 🟢 P1   | Popup status                                                       | Chưa làm                  | Low     |
| 🟢 P1   | WS security hardening                                              | Chưa làm                  | Low–Med |
| 🟡 P2   | History/Bookmarks/TopSites                                         | Optional                  | Low     |
| ❌      | Phần còn lại của plan cũ                                           | Loại / hoãn               | —       |
