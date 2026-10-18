# Kế Hoạch Tách & Triển Khai Extension Riêng: `WebMCP Vault Companion v1.0.0` + Làm Sạch `WebMCP Tools Provider v2.1.14`

- **Plan ID**: `PLAN-WEBMCP-VAULT-EXT-SPLIT-V1`
- **Ngày lập**: `2026-10-17`
- **Mục tiêu**:
  1. **Giữ nguyên 100% các nâng cấp & bản vá không phải Vault** trên [`webmcp-browser-kit/webmcp-extension`](file:///Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/packages/webmcp-browser-kit/webmcp-extension/dist/manifest.json) (`v2.1.14`), đồng thời gỡ bỏ phần DOM Password/Passkey Autofill khỏi `webmcp-extension` để bảo vệ tuyệt đối tiêu chuẩn **Single Purpose** trên Chrome Web Store.
  2. **Khởi tạo Extension độc lập [`webmcp-vault-kit/webmcp-vault-extension`](file:///Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/packages/webmcp-vault-kit/webmcp-vault-extension/dist/manifest.json) (`v1.0.0`)** chuyên trách **Zero-Click Passkey + 1Password-Style Password/OTP Autofill + Popup Vault UI**, khắc phục triệt để 100% các phát hiện bảo mật của **Claude Opus 5.5 High** (cô lập Password/OTP sang `ISOLATED` world, xóa biến global trên `MAIN` world, tắt blind autofill lúc `DOMContentLoaded`).

---

## 1. Kiến Trúc Phân Tách 2 Extensions (`Separation of Concerns`)

| Tiêu chí | Extension 1: `WebMCP Tools Provider` (`v2.1.14`) | Extension 2: `WebMCP Vault Companion` (`v1.0.0`) |
| :--- | :--- | :--- |
| **Vị trí Package** | `webmcp-browser-kit/webmcp-extension/` | `webmcp-vault-kit/webmcp-vault-extension/` |
| **Single Purpose (CWS)** | Cầu nối tự động hóa trình duyệt & quản lý phiên/tab cho AI Agent (`ws://localhost:7865`). | Trình quản lý Passkey, Mật khẩu & 2FA OTP kết nối Local Vault (`http://127.0.0.1:7876`). |
| **Permissions** | `alarms`, `debugger`, `tabs`, `webNavigation`, `downloads`, `storage`, `identity`, `identity.email` | **Tối thiểu**: `storage`, `tabs` (0 `debugger`, 0 `downloads`, 0 `identity`). |
| **MAIN World Script** | `webmcp-polyfill.js` + `register-tools.js` (tự xóa `window.__webmcp_internal__` ngay khi nạp xong). | `passkey-main.js` (~210 LOC): Chỉ hook `navigator.credentials.get/create` cho WebAuthn, **không chạm vào password/OTP**, không phơi biến global. |
| **ISOLATED World Script** | `aria-snapshot.js` + `bridge.js` (chỉ whitelist các lệnh network capture + khóa `<title>` tab). | `vault-content.js` (~430 LOC): Toàn bộ Password/OTP Autofill, Shadow DOM Inline Menu (`Alt+K`), Autosave, và Passkey UI Toast/Picker. |
| **Popup UI (`/design-taste-frontend`)** | Linear Dark-Tech 2 Tabs: **`Control`** (Rename Tab, `+ [Profile]`, Profile ID, CDP Detach) & **`Gateway`** (Config `gatewayUrl`). | Linear Dark-Tech 2 Tabs: **`Accounts`** (Search + `[Fill]`, `[Copy User]`, `[Copy Pass]`, `[Copy OTP]`, `[Inline Alt+K]`) & **`Settings`** (Config `vaultUrl` + Autosave toggle). |

---

## 2. Danh Sách Hạng Mục Thực Thi (Checkbox Action Plan)

### 🛠️ Milestone 1: Làm Sạch & Gia Cố Stealth cho `WebMCP Tools Provider v2.1.14` (`webmcp-browser-kit`)
- [x] **Task 1.1 (`manifest.json`)**:
  - Xóa `content-scripts/passkey-provider.js` khỏi `content_scripts` (và xóa file `webmcp-extension/dist/content-scripts/passkey-provider.js`).
  - Đổi `action.default_title` thành `"WebMCP Tools Provider"` và chuẩn hóa `description` đúng CWS Single Purpose.
- [x] **Task 1.2 (`content-scripts/webmcp-polyfill.js`, `content-scripts/register-tools.js`, `content-scripts/bridge.js`)**:
  - Trong `register-tools.js`: Sau khi destructure `window.__webmcp_internal__`, gọi `try { delete window.__webmcp_internal__; } catch {}` để xóa sạch dấu vết trên `MAIN` world (chống Anti-Bot Fingerprinting).
  - Trong `bridge.js`: Chỉ cho phép `window.postMessage` (`WEBMCP_BG_REQUEST`) gọi 4 hàm network capture (`start_network_capture`, `stop_network_capture`, `wait_for_network_response`, `get_captured_requests`); gỡ bỏ `WEBMCP_VAULT_CMD`.
- [x] **Task 1.3 (`bg/ws-client.js`, `bg/events.js`, `popup.html`, `popup.js`)**:
  - Giữ lại toàn bộ cấu hình động `gatewayUrl` (`DEFAULT_WS_URL`, `normalizeGatewayUrl`, `getCurrentGatewayUrl`, `getServiceUrls`, `saveServiceUrls`) trong `ws-client.js`.
  - Gỡ bỏ các handler HTTP gọi sang Vault (`passkey_*`, `credentials_*`, `vaultCandidates`, `vaultFill`, `testVault`) khỏi `bg/events.js` (vẫn giữ nguyên `bg/handlers/passkey-actions.js` cho lệnh CDP `passkey.authenticateWithVirtualAuthenticator` của Agent).
  - Tinh gọn `popup.html` & `popup.js` về 2 tab chuẩn Linear Dark-Tech: **`Control`** (Tab Rename, `+ [Profile]`, Profile Identity, CDP Debugger) và **`Gateway`** (Gateway WebSocket URL configuration).
- [x] **Task 1.4 (`tests/unit/extension-v2.1.14.test.mjs`)**:
  - Cập nhật unit tests kiểm chứng toàn bộ tính năng `v2.1.14` (M1–M4: Detach hooks, Runtime sync, Self-attach recovery, Polyfill + 14 tool annotations + xóa `window.__webmcp_internal__`, Action badge, Emulation idle guard, Iframe security, Dynamic Gateway URL) và đóng gói lại `webmcp-extension-v2.1.14.zip`.

### 🔐 Milestone 2: Xây Dựng Mới `WebMCP Vault Companion v1.0.0` (`webmcp-vault-kit`)
- [x] **Task 2.1 (`webmcp-vault-extension/dist/manifest.json`, `icons/`, `scripts/build-extension-zip.mjs`, `package.json`)**:
  - Tạo cấu trúc Manifest V3 chuẩn Single Purpose cho `WebMCP Vault Companion` (`v1.0.0`), quyền tối thiểu `["storage", "tabs"]`, `host_permissions: ["<all_urls>"]`.
  - Thêm script `npm run build:extension` vào `webmcp-vault-kit/package.json` để đóng gói `webmcp-vault-extension-v1.0.0.zip`.
- [x] **Task 2.2 (`webmcp-vault-extension/dist/content-scripts/passkey-main.js` — `MAIN` world, `< 250 LOC`)**:
  - Chỉ intercept `navigator.credentials.get` và `navigator.credentials.create` cho WebAuthn Passkeys.
  - Giao tiếp với `vault-content.js` (`ISOLATED` world) qua `CustomEvent` chỉ truyền dữ liệu công khai WebAuthn (challenge, rpId, publicKey, assertion signature) — **tuyệt đối không bao giờ truyền hay nhận password/OTP** và không để lại biến global trên `window`.
- [x] **Task 2.3 (`webmcp-vault-extension/dist/content-scripts/vault-content.js` — `ISOLATED` world, `< 500 LOC`)**:
  - Chạy hoàn toàn trong `ISOLATED` world, gọi trực tiếp `chrome.runtime.sendMessage` tới `background.js`.
  - Hiển thị Shadow DOM Passkey Picker & Toast xác thực.
  - Thực thi Password & 2FA OTP Autofill + Shadow DOM Inline Menu (`Alt+K`) **chỉ khi có tương tác người dùng (`focusin`, `Alt+K`) hoặc lệnh `[Fill]` từ Popup** (tắt blind autofill lúc `DOMContentLoaded`).
  - Hỗ trợ Autosave mật khẩu về Local Vault (có thể bật/tắt qua `chrome.storage.local`).
- [x] **Task 2.4 (`webmcp-vault-extension/dist/background.js`, `< 300 LOC`)**:
  - Quản lý `vaultUrl` (mặc định `http://127.0.0.1:7876`), kiểm tra `resolveValidRpId(requestedRpId, hostname)` (chặn cross-domain, IP suffix, public suffix `co.uk`/`com.vn`, shared hosts `github.io`/`vercel.app`), cưỡng bức `web: verifiedOrigin` & `origin: verifiedOrigin`.
  - Cập nhật Action Badge hiển thị số lượng tài khoản khớp domain trên tab đang mở.
- [x] **Task 2.5 (`webmcp-vault-extension/dist/popup.html` & `popup.js` — Linear Dark-Tech UI, `< 450 LOC`)**:
  - Thiết kế theo `/design-taste-frontend` (`#09090b` Zinc-950, `#121215` cards, status strip `Vault :7876 · Online`, 2 tabs `Accounts` | `Settings`).
  - Tab **`Accounts`**: Ô tìm kiếm tức thì + danh sách tài khoản khớp domain với nút `[Fill]` (điền đè Username/Password/OTP + copy OTP), `[Copy User]`, `[Copy Pass]`, `[Copy OTP]`, `[Inline (Alt+K)]`.
  - Tab **`Settings`**: Cấu hình `Vault Kit HTTP URL`, công tắc `Auto-save Passwords on Login`, nút `[Ping Vault]`, `[Defaults]`, `[Save & Apply]`.
- [x] **Task 2.6 (`webmcp-vault-kit/tests/unit/vault-extension.test.mjs`)**:
  - Viết bộ unit tests kiểm chứng `resolveValidRpId`, `normalizeVaultUrl`, `web: verifiedOrigin` override protection, `ISOLATED` world credential handling, và Popup actions (`vaultCandidates`, `vaultFill`, `saveSettings`).

---

## 3. Hồ Sơ Kiểm Duyệt Đa Agent (Verification Ledger)

| Vai trò | Model / Subagent | Trạng thái | Ghi chú |
| :--- | :--- | :---: | :--- |
| **Coordinator** | `Gemini 4 Argon` | ✅ **PASS** | Thiết kế kiến trúc tách 2 extensions & điều phối kiểm증. |
| **L1 Pre-Accept** | `Gemini 4 Argon` (`1765d63c`) | ✅ **PASS** | Kiểm duyệt cả `webmcp-extension v2.1.14` & `webmcp-vault-extension v1.0.0`. |
| **L2 Final Review** | `Claude Opus 5.5 High` | ✅ **PASS** | Kiểm toán bảo mật `MAIN` vs `ISOLATED` world & CWS compliance. |
