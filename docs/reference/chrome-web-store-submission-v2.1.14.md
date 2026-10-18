# Chrome Web Store Submission Guide — WebMCP Tools Provider v2.1.14

Tài liệu chuẩn bị đầy đủ thông tin mô tả (Description), tóm tắt (Summary), giải trình quyền hạn (Privacy Justifications) và file zip đóng gói để cập nhật `WebMCP Tools Provider v2.1.14` trên Chrome Web Store Developer Dashboard.

---

## 1. File Upload Package (Đã đóng gói và chuyển lên Mac M1)

- **Trên máy Mac M1:**
  - Đường dẫn: `/Users/uyenuyen/Downloads/webmcp-extension-v2.1.14.zip` (Dung lượng: ~93 KB)
  - *(Tùy chọn) WebMCP Vault Companion:* `/Users/uyenuyen/Downloads/webmcp-vault-extension-v1.0.0.zip` (~799 KB)
- **Trên máy chính (Local):**
  - `/Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/packages/webmcp-browser-kit/webmcp-extension/build/webmcp-extension-v2.1.14.zip`

---

## 2. Store Listing Metadata (Thông tin hiển thị trên Store)

### Tên Extension (Item Name)
```text
WebMCP Tools Provider
```

### Tóm tắt ngắn (Summary — tối đa 132 ký tự)
```text
Control your browser from AI agents via a local bridge. Exposes page tools through WebMCP and runs automation commands locally.
```
*(Độ dài: 126 / 132 ký tự)*

### Phiên bản (Version)
```text
2.1.14
```

### Danh mục (Category)
```text
Developer Tools
```

### Ngôn ngữ chính (Default Language)
```text
English
```

---

## 3. Mô tả chi tiết (Detailed Description)

*Dán toàn bộ nội dung dưới đây vào ô **Detailed description** trong mục Store Listing:*

```markdown
WebMCP Tools Provider turns Google Chrome into an open, secure, and developer-friendly automation surface for local AI agents and the Model Context Protocol (MCP).

It establishes a secure local bridge between your browser and local AI workflows (Claude, Cursor, Codex, OpenCode, and local LLM runners) via a local WebSocket Gateway (localhost only).

WHAT'S NEW IN V2.1.14:
• New Linear Dark-Tech Control Popup:
  - Custom Tab Titles: Rename and lock tab titles directly with persistent mutation locks.
  - Profile Quick-Prefix: One-click "+ [Profile]" prefixing for multi-account workflows.
  - Tab Metadata Exporter: Instant "Copy JSON" of tab ID, profile, and current URL for agents.
  - Fast CDP Controls: Detach tab or detach all active debugger sessions with a single click.
  - Dynamic Gateway Config: Configure and switch Gateway WebSocket URLs on the fly.
• 45s Idle Auto-Detach: Automatically dismisses the yellow "debugging" warning bar after 45 seconds of inactivity.
• Self-Attach Recovery: Seamlessly recovers debugger attachments across Service Worker restarts.
• W3C WebMCP 2026 Dual-Alias: Full dual support for `document.modelContext` and `navigator.modelContext` with tool execution annotations (`readOnlyHint`, `consequentialHint`).
• Zero-Footprint Stealth: Completely eliminates main-world traces, console noise, and global leaks.
• Secure Vault Delegation: Decoupled architecture supporting credential autofill delegation without bloating the core automation kit.

CORE CAPABILITIES:
- Read page content, ARIA accessibility snapshots, and interactive element trees.
- Click, type, scroll, and submit forms reliably with DOM and CDP fallback.
- Tab lifecycle management (create, switch, rename, close, list).
- Inspect cookies, localStorage, and network activity.
- Expose and invoke custom web tools registered via `navigator.modelContext` / `document.modelContext`.

PRIVACY & LOCAL-FIRST GUARANTEE:
- All communications are strictly restricted to your local machine (127.0.0.1 / localhost).
- Zero remote analytics, zero telemetry, zero advertisements, and zero third-party cloud connections.
- Fully transparent and inspectable local bridge.
```

---

## 4. Privacy Tab — Bảng giải trình quyền hạn (Privacy Justifications)

*Google yêu cầu giải trình cụ thể cho từng permission trong Manifest V3:*

### Tuyên bố mục đích duy nhất (Single Purpose Statement)
```text
Expose the current browser to a local, user-run automation gateway so AI agents can read and operate web pages on the user's behalf.
```

### Chi tiết từng Permission (Per-permission justifications):

| Permission | Justification (Dán vào ô tương ứng) |
| :--- | :--- |
| `debugger` | Used to perform reliable input (clicks, keystrokes), capture screenshots, and intercept network activity via the Chrome DevTools Protocol — capabilities standard extension APIs cannot provide for automation. |
| `<all_urls>` | The extension is a general-purpose developer automation tool; the user directs it at whichever site they are automating, so host access cannot be limited to a static list. |
| `scripting` | Injects the content-script bridge and the page-tool registration script so web pages can expose WebMCP tools. |
| `tabs` | Lists, creates, switches, renames, and closes tabs as part of automated agent workflows. |
| `activeTab` | Operates on the tab the user is currently driving. |
| `storage` | Persists local extension settings, custom tab names, and connection state. |
| `downloads` | Saves files and screenshots produced by automation to the user's local machine. |
| `alarms` | Keeps the background service worker and gateway connection alive reliably. |

### Khai báo dữ liệu người dùng (Data usage disclosures)
- Đánh dấu chọn: **Does NOT collect or transmit user data to remote servers**.
- Toàn bộ lưu lượng mạng là nội bộ máy (`127.0.0.1` / `localhost`).
- Không có mã thực thi từ xa (No remote code).
