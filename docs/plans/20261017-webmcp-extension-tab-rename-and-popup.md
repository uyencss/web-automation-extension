# Kế Hoạch Kỹ Thuật Tối Giản: Tích Hợp Rename Tab & Control Popup Cho WebMCP Extension (/ponytail full)

- **Mã kế hoạch**: `PLAN-WEBMCP-EXT-TAB-RENAME-POPUP`
- **Ngày lập**: 2026-10-17
- **Tác giả / Điều phối**: Antigravity Orchestrator (Gemini 4 Argon)
- **Hội đồng Thẩm định & Phản biện (`/multi-ai-research` × `/ponytail`)**:
  - **Architectural & Final Plan Critic**: Claude Opus 5.5 High (`claude --model opus --effort high` — 12 Findings `F1`–`F12`)
  - **Deep Reasoning Reviewer**: DeepSeek v4.1 Flash (`opencode/deepseek-v4.1-flash-free` — 11 Findings `F1`–`F11`)
  - **Writer dự kiến**: Gemini Flash 3.8 / Claude Sonnet 5.5
- **Target Workspace**: `webmcp-automation-kit/packages/webmcp-browser-kit` (`webmcp-extension/dist/`)

---

## 1. Mục Tiêu & Quyết Định Cắt Gọn Theo Lăng Kính `/ponytail`

Thay thế hoàn toàn 2 extension rời đang cài trong profile `harry2906090` (`Tab Rename` và `Tab Modifier` dài 1.242 dòng) bằng cơ chế **Rename Tab + Control Popup** gọn nhẹ (~230 dòng code tổng cộng, **0 thư viện ngoài, 0 quyền mới trong `manifest.json`**) tích hợp trực tiếp vào `webmcp-extension`.

### Bảng Quyết Định Giữ / Cắt Của Claude Opus 5.5 High (`/ponytail` Ladder)

| Hạng mục đề xuất | Quyết định | Lý do kỹ thuật & Lăng kính `/ponytail` |
| :--- | :---: | :--- |
| **1. Rename Tab (CLI `renameTab` + Popup Input & Reset)** | ✅ **GIỮ** | Nhu cầu cốt lõi. Lưu theo `title:${tabId}` trong `chrome.storage.session`, chống đụng tên khi mở 20–50 tab cùng URL, giữ tên qua F5/reload và SPA route change. |
| **2. Gateway Status (`connecting`/`open`/`closed`) + `Reconnect`** | ✅ **GIỮ** | Tận dụng `ws` có sẵn trong `ws-client.js`; giải quyết điểm mù không biết extension đã kết nối vào `ws://localhost:7865` hay đang kẹt backoff 30s. |
| **3. Profile Identity (`profileName`, `email`, `id`) + Sửa nhanh** | ✅ **GIỮ** | Tái sử dụng `getProfileInfo()` và hợp nhất với handler `setProfileName` sẵn có trong `ws-client.js`. Cho phép xóa trắng để về lại mặc định prefix email. |
| **4. CDP Debugger Status (`attachedTabs`) + Nút `Detach`** | ✅ **GIỮ** | Tận dụng `attachedTabs` và `detachDebugger` sẵn có; giúp tắt ngay thanh cảnh báo vàng của Chrome và giải phóng debugger khi đụng độ extension ChatGPT/Codex. |
| **5. Nút `Copy Target JSON`** | ✅ **GIỮ** | Copy `{ profileId, profileName, tabId, url, title }` bằng `navigator.clipboard.writeText` (không cần thêm permission). Cắt bỏ chuỗi CLI flag tự chế vì dễ lệch tham số `--profile-id`. |
| **6. Công tắc `Protect Tab` (`window.onbeforeunload`)** | ❌ **CẮT HẲN** | **[Opus F1 - High]:** `evaluateInTab` dùng `userGesture: true` tạo sticky activation; nếu gán `beforeunload`, lệnh `navigate` của WebMCP sẽ làm bật hộp thoại xác nhận của Chrome, gây treo `navigate` 30s và khóa cứng mọi lệnh CDP sau đó. |
| **7. Chấm màu Favicon (`<canvas>` Color Dot)** | ❌ **CẮT HẲN** | **[Opus F2 - Medium]:** Ghi đè `<link rel="icon">` làm bẩn DOM của trang và phải nuôi thêm observer thứ 2 đánh nhau với SPA (YouTube, ChatGPT). Nếu cần đánh dấu màu, chỉ cần gõ Emoji (`🟢`, `🔴`, `🟡`) vào đầu tên Tab khi Rename (0 dòng code). |

---

## 2. Kiến Trúc Kỹ Thuật & Các Chốt Chặn An Toàn (Opus 5.5 Findings)

### A. Bảo Mật Biên Nhận Message (`[Opus F3 - Critical]`)
- Hiện tại `content-scripts/bridge.js` đang relay `data.payload` thô từ `MAIN` world sang `chrome.runtime.sendMessage`. Do đó, script của website bất kỳ có thể giả mạo message gửi lên background.
- **Chốt chặn bắt buộc trong `bg/events.js`**:
  1. Mọi lệnh từ Popup (`type === 'WEBMCP_POPUP'`) **bắt buộc kiểm tra**:
     ```js
     if (sender.tab || !sender.url?.startsWith(chrome.runtime.getURL(''))) {
       sendResponse({ error: 'Unauthorized sender' });
       return false;
     }
     ```
  2. Lệnh khởi tạo tiêu đề lúc load trang (`type === 'WEBMCP_TAB_TITLE_INIT'`) **chỉ đọc** state từ `sender.tab?.id` khi `sender.frameId === 0`, tuyệt đối không cho phép content script tự ghi tên mới vào `chrome.storage.session`.

### B. Khóa `<title>` Chống SPA Ghi Đè Tại `content-scripts/bridge.js` (`[Opus F7]`)
- **Không chạm `MAIN` world (`register-tools.js`)**: Tránh làm thay đổi `Object.getOwnPropertyDescriptor(Document.prototype, 'title')` gây lộ fingerprint với Cloudflare Turnstile / TikTok anti-bot.
- **Chạy ở `ISOLATED` world, chỉ tại Top Frame (`window.top === window`)**:
  - Lưu `lockedTitle` (tên khóa) và `pageTitle` (tên gốc mới nhất do trang tự đặt).
  - Không dùng cờ `isApplying` vô tác dụng (vì callback `MutationObserver` chạy ở microtask sau khi câu lệnh đồng bộ đã kết thúc); chính phép so sánh `document.title !== lockedTitle` chặn đứng vòng lặp vô hạn.
  - **Không observe toàn bộ `document` với `characterData: true`** (tránh tốn CPU trên các trang streaming văn bản liên tục như ChatGPT). Chỉ observe **`document.head`** (`{ subtree: true, childList: true, characterData: true }`); nếu tại `document_start` chưa có `document.head` thì đợi `DOMContentLoaded` mới gắn vào `document.head`.
  - Khi reset (`lockedTitle = null`), gọi `observer.disconnect()` ngay lập tức (0% overhead khi không khóa tên) và khôi phục `document.title = pageTitle`.
  - Kiểm tra `!chrome.runtime?.id` trong callback để tự `disconnect()` nếu content script bị mồ côi sau khi reload extension.

### C. Quản Lý Vòng Đời State Theo `tabId` (`[Opus F8 & F9]`)
- Lưu trực tiếp vào `chrome.storage.session` với key `title:${tabId}` (giá trị là chuỗi `customTitle`). Không tạo `Map` cache thừa trong bộ nhớ SW vì SW MV3 có thể ngủ bất cứ lúc nào.
- **Cơ chế Pull tại `document_start`**: Khi tab F5/reload hoặc điều hướng sang trang mới, `bridge.js` gửi `WEBMCP_TAB_TITLE_INIT` lên background và khóa tên ngay khi `<head>` xuất hiện, không bị nháy tên gốc.
- **Dọn rác & Chuyển tiếp**:
  - `chrome.tabs.onRemoved(tabId)` $\rightarrow$ `chrome.storage.session.remove('title:' + tabId)`.
  - `chrome.tabs.onReplaced(addedTabId, removedTabId)` $\rightarrow$ chuyển giá trị từ `title:${removedTabId}` sang `title:${addedTabId}` và xóa key cũ.
- **Xử lý Tab mở trước khi cài extension hoặc trang `chrome://` (`[Opus F9]`)**:
  - Vẫn lưu `title:${tabId}` vào `chrome.storage.session`, bắt lỗi `chrome.tabs.sendMessage` (`Receiving end does not exist`) và trả về `{ tabId, title: customTitle, customTitle, applied: false, reason: 'reload-required' }`. Trên Popup hiển thị dòng nhắc nhẹ: *"Reload tab (F5) để áp dụng tên mới"*.

### D. Sửa Lỗi Ngầm `detachDebugger` Trong `bg/cdp-bridge.js` (`[Opus F4 - High]`)
- Hiện tại `detachDebugger(tabId)` chỉ xóa `attachedTabs` và `invalidateFrameCaches(tabId)`, nhưng **quên xóa `pageEnabledTabs`, `runtimeEnabledTabs`, `mainWorldContexts`** (sự kiện `chrome.debugger.onDetach` không bắn khi chính extension chủ động gọi `chrome.debugger.detach`).
- **Sửa tại nút thắt gốc (`cdp-bridge.js`)**: Gom việc xóa 4 cấu trúc (`attachedTabs`, `pageEnabledTabs`, `runtimeEnabledTabs`, `mainWorldContexts`, `invalidateFrameCaches`) vào hàm chung `cleanupTabDebuggerState(tabId)` dùng cho cả `detachDebugger(tabId)` và `onDetach`.

### E. Tái Sử Dụng `reconnectNow()` & `applyProfileName()` Trong `bg/ws-client.js` (`[Opus F5 & F6]`)
- Export `reconnectNow()`: xóa timer backoff (`clearReconnectTimer()`), đặt `reconnectAttempt = 0`, nếu `ws` đang mở/kết nối thì `ws.close()` rồi gọi `connectWebSocket()`.
- Export `applyProfileName(name)`: nếu `name.trim()` có giá trị thì lưu `chrome.storage.local.set({ webmcp_profile_name: name.trim() })`, nếu rỗng thì `chrome.storage.local.remove('webmcp_profile_name')` (để quay về tên mặc định từ email), sau đó gọi `reconnectNow()`. Dùng chung cho cả lệnh WS `setProfileName` và Popup.

---

## 3. Danh Sách Tệp Thay Đổi (Write-Set)

1. `webmcp-automation-kit/packages/webmcp-browser-kit/webmcp-extension/dist/manifest.json`:
   - Thêm `"action": { "default_popup": "popup.html", "default_title": "WebMCP Control & Rename Tab" }`.
   - Thêm `"commands": { "_execute_action": { "suggested_key": { "default": "Alt+Shift+W" }, "description": "Open WebMCP popup & rename tab" } }`.
2. `webmcp-automation-kit/packages/webmcp-browser-kit/webmcp-extension/dist/popup.html` *(File mới ~45 dòng)*:
   - Giao diện tối giản Dark Mode gồm: Header trạng thái WS + nút `Reconnect`, dòng `Profile Name` + nút `Save`, khu vực `Rename Tab` (input auto-focus + nút `Save` / `Reset` + `Copy JSON`), và thanh trạng thái `CDP Debugger` + nút `Detach Tab` / `Detach All`.
3. `webmcp-automation-kit/packages/webmcp-browser-kit/webmcp-extension/dist/popup.js` *(File mới ~80 dòng)*:
   - Gửi `WEBMCP_POPUP` (`method: 'status' | 'renameTab' | 'reconnect' | 'setProfileName' | 'detach'`), `await` phản hồi hoàn tất rồi mới `window.close()` khi nhấn Enter lưu tên tab (`[Opus F11]`).
4. `webmcp-automation-kit/packages/webmcp-browser-kit/webmcp-extension/dist/content-scripts/bridge.js`:
   - Bổ sung khối khóa `<title>` ở top frame (`window.top === window`) bằng `MutationObserver` trên `document.head` và gửi `WEBMCP_TAB_TITLE_INIT`.
5. `webmcp-automation-kit/packages/webmcp-browser-kit/webmcp-extension/dist/bg/cdp-bridge.js`:
   - Sửa `detachDebugger(tabId)` xóa đầy đủ `pageEnabledTabs`, `runtimeEnabledTabs`, `mainWorldContexts`.
6. `webmcp-automation-kit/packages/webmcp-browser-kit/webmcp-extension/dist/bg/ws-client.js`:
   - Export `reconnectNow()`, `applyProfileName(name)` và thêm `'renameTab'` vào mảng `capabilities`.
7. `webmcp-automation-kit/packages/webmcp-browser-kit/webmcp-extension/dist/bg/handlers/tab-management.js`:
   - Thêm handler `renameTab({ tabId, title })` (truyền `title` rỗng/null để reset) và bổ sung trường `customTitle` (nếu có) vào kết quả `listTabs()`.
8. `webmcp-automation-kit/packages/webmcp-browser-kit/webmcp-extension/dist/bg/events.js`:
   - Xử lý `WEBMCP_TAB_TITLE_INIT`, `WEBMCP_POPUP` (có kiểm tra `sender`), dọn `title:${tabId}` ở `tabs.onRemoved` và chuyển tiếp ở `tabs.onReplaced`.
9. Đăng ký Command & Đồng bộ Tài liệu:
   - `webmcp-automation-kit/packages/webmcp-browser-kit/catalog/command-catalog.js`
   - `webmcp-automation-kit/packages/webmcp-browser-kit/server/gateway/verifier.mjs` (`KNOWN_RAW_METHODS`)
   - `webmcp-automation-kit/packages/webmcp-browser-kit/scripts/generate-tool-reference.js`
   - `webmcp-automation-kit/packages/webmcp-browser-kit/skills/webmcp-browser-automation/references/generated-tools.md` (chạy `npm run tools:generate`)

---

## 4. Kế Hoạch Thực Hiện Theo Từng Milestone

### Milestone 1: Nâng Cấp Core Background (`cdp-bridge.js`, `ws-client.js`, `tab-management.js`)
- [x] **Task 1.1**: Hợp nhất hàm dọn state `cleanupTabDebuggerState(tabId)` trong `bg/cdp-bridge.js` để `detachDebugger(tabId)` xóa sạch `pageEnabledTabs`, `runtimeEnabledTabs`, `mainWorldContexts`.
- [x] **Task 1.2**: Tách và export `reconnectNow()` cùng `applyProfileName(name)` trong `bg/ws-client.js`; thêm `'renameTab'` vào danh sách `capabilities` khi gửi `extensionReady`.
- [x] **Task 1.3**: Triển khai `renameTab(params)` và cập nhật `listTabs()` trả thêm `customTitle` (khi tab có đặt tên trong `chrome.storage.session`) tại `bg/handlers/tab-management.js`.

### Milestone 2: Content Script Title Lock & Events Router (`bridge.js`, `events.js`)
- [x] **Task 2.1**: Bổ sung bộ khóa tiêu đề trang (`WEBMCP_TAB_TITLE` & `WEBMCP_TAB_TITLE_INIT`) tại `content-scripts/bridge.js` (chỉ chạy ở `window.top === window`, observe `document.head`, tự ngắt observer khi reset hoặc khi extension context invalidated).
- [x] **Task 2.2**: Trong `bg/events.js`, thêm listener cho `WEBMCP_TAB_TITLE_INIT` (chỉ đọc `sender.tab.id` ở `frameId === 0`), `WEBMCP_POPUP` (chốt chặn `!sender.tab && sender.url?.startsWith(chrome.runtime.getURL(''))`), cùng dọn rác ở `chrome.tabs.onRemoved` và chuyển khóa ở `chrome.tabs.onReplaced`.

### Milestone 3: Giao Diện Control Popup & Phím Tắt (`manifest.json`, `popup.html`, `popup.js`)
- [x] **Task 3.1**: Cập nhật `manifest.json` thêm `action.default_popup: "popup.html"` và `commands._execute_action` (`Alt+Shift+W`).
- [x] **Task 3.2**: Tạo `popup.html` và `popup.js` với 5 chức năng tinh gọn:
  1. Ô nhập **Rename Tab** (auto-focus, nhấn `Enter` để lưu và đóng, nút `Reset` về tên gốc, cảnh báo nhẹ nếu tab cần F5).
  2. Trạng thái **Gateway WS** (`🟢 Connected` / `🟡 Connecting` / `🔴 Disconnected`) + nút `Reconnect`.
  3. Ô **Profile Name** (hiển thị kèm `email` / `profileId`, lưu tên mới hoặc xóa trắng về mặc định).
  4. Trạng thái **CDP Debugger** (`Attached` trên tab hiện tại / tổng số tab) + nút `Detach Tab` / `Detach All`.
  5. Nút **Copy JSON** (`{ profileId, profileName, tabId, url, title }`).

### Milestone 4: Đồng Bộ Gateway Allowlist, Catalog & Kiểm Thử Đa Tầng
- [x] **Task 4.1**: Thêm `'renameTab'` vào `catalog/command-catalog.js`, `server/gateway/verifier.mjs` (`KNOWN_RAW_METHODS`), và `scripts/generate-tool-reference.js`.
- [x] **Task 4.2**: Chạy `npm run tools:generate` và `npm run tools:check` để đồng bộ `generated-tools.md`.
- [x] **Task 4.3**: Bổ sung unit test cho `renameTab` và chạy toàn bộ test suite (`npm test`, bao gồm `tests/unit/gateway-command-adapter.test.mjs` và `gateway-multi-profile.test.mjs`).
- [x] **Task 4.4**: Chạy cổng nghiệm thu đa AI (DeepSeek v4.1 Flash + Claude Opus 5.5 High Final Review) trước khi đóng gói bản build zip mới (`verdict: "approve"`, đã đóng gói `webmcp-extension/build/webmcp-extension-v2.1.12.zip`).

---

## 5. Kết Quả Thực Thi & Nghiệm Thu (Orchestration Summary)

- **Primary Writer**: Gemini Flash 3.8 Subagent (`5a220436-fc44-4954-9405-170dbc8d933e`)
- **L1 Pre-Accept Reviewer**: Gemini 4 Argon Medium (Coordinator) — Kiểm tra cú pháp `node --check`, ranh giới write-set và unit tests qua cả 4 Milestone.
- **L2 Final Reviewer**: Claude Opus 5.5 High (`webmcp-ai review --provider claude --model opus --effort high`)
  - **Vòng 1**: Phát hiện 4 điểm cần tinh chỉnh (`R1`: ngắt listener socket cũ trong `reconnectNow()` trước khi `close()` để tránh race condition; `R2`: giới hạn độ dài `customTitle` tối đa 256 ký tự; `R3`: thêm cờ `hasCapturedPageTitle` để khôi phục đúng cả khi `document.title` gốc là chuỗi rỗng; `R4`: dùng optional chaining `request?.type` trong `bg/events.js`). Đã được Flash 3.8 Writer khắc phục triệt để.
  - **Vòng 2**: **`verdict: "approve"`** — 0 lỗi Critical/High/Security, toàn bộ unit tests (`tests/unit/rename-tab.test.mjs`, `tests/unit/gateway-command-adapter.test.mjs`) và `npm run tools:check` đạt 100%, đã đóng gói thành công `webmcp-extension/build/webmcp-extension-v2.1.12.zip`.
