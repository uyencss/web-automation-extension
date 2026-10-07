# WebMCP Browser Kit: Kế Hoạch Tối Giản Nâng Cấp Từ Kiến Trúc Codex (Ponytail Lens)

> **Mục tiêu:** Tiếp thu những điểm mạnh nhất từ kiến trúc browser automation của OpenAI Codex (CDP AX, Stale Ref Guard, Token Optimization) nhưng loại bỏ hoàn toàn các bẫy over-engineering (WASM, hybrid merger, animation thừa). Triển khai ít dòng code nhất, đạt hiệu quả và độ ổn định cao nhất, đồng thời cập nhật Skill để AI Agent biết cách vận hành tối ưu.

---

## 1. Hội Đồng Đánh Giá Phản Biện (Ponytail Review)

### Góc nhìn 1: OpenAI GPT-6.1 Sol (High Reasoning)
* **Phán quyết:** **Làm #3 trước; #1 làm có điều kiện; hoãn #2; giữ #4 OFF hoàn toàn.**
* **Lý do:**
  - **Hybrid AX (#1):** Dùng CDP Native AX rất tốt nhưng *trộn 2 cây (DOM + CDP)* là cái bẫy kỹ thuật kinh điển. Hai nguồn dữ liệu sẽ sinh ra xung đột id, deduplication, desync. Chỉ làm CDP AX như một engine riêng biệt khi có debugger, không bao giờ viết code đồng bộ 2 cây.
  - **Tree Diffing (#2):** Cây diff dạng AST đòi hỏi quản lý baseline, reparenting, deletion tombstone. Quá cồng kềnh. Cách lười nhất mà hiệu quả: so sánh chuỗi hoặc short-circuit khi không đổi.
  - **Stale Ref Guard (#3):** Bắt buộc phải có để tránh click vào node rác. Nhưng tuyệt đối không âm thầm "đoán" node thay thế. Nếu node disconnected hoặc đổi page -> fail fast để agent chụp lại snapshot mới.
  - **Cursor Animation (#4):** Không chứng minh tăng tỷ lệ task thành công. Chỉ làm tốn CPU và chậm thời gian chạy. Giữ OFF hoặc chỉ ghi roadmap 1 dòng.

### Góc nhìn 2: Claude Sonnet 5.5
* **Phán quyết:** **Đồng thuận 100% với triết lý YAGNI (You Aren't Gonna Need It).**
* **Lý do:**
  - **Bệnh over-engineering phổ biến:** Cố sao chép lõi WASM C++/Swift của Codex vào WebMCP là tự đào hố chôn mình. Codex phải làm WASM vì nó chạy native app đa nền tảng kết hợp desktop overlay. WebMCP là Chrome Extension + Node MCP Gateway, JavaScript runtime của Node/V8 đã cực kỳ mạnh.
  - **Điểm ROI cao nhất:**
    1. Tránh click sai vào DOM đã chết (Stale Ref Fast-Fail).
    2. Tránh gửi lại toàn bộ snapshot khi DOM không đổi (Unchanged Short-Circuit).

---

## 2. Ma Trận Quyết Định (Decision Matrix)

| Đề xuất | Đánh giá | Trạng thái | Giải pháp tối giản (Ponytail / Lazy Senior) | Độ phức tạp |
| :--- | :--- | :--- | :--- | :--- |
| **1. CDP Native AX Tree** | Cần cho Shadow DOM/Iframe phức tạp, nhưng KHÔNG ghép hybrid | **P1 (Tùy chọn)** | Thêm engine `cdp` độc lập trong `cdp-bridge.js`. Dùng `Accessibility.getFullAXTree` format ra cùng chuẩn text ref. Không đụng đến `aria-snapshot.js`. | ~60 dòng code |
| **2. Tree Diffing** | AST diffing quá phức tạp; chuỗi diffing đủ xài | **P0 (Làm ngay)** | **Unchanged Short-Circuit**: Lưu hash/string của snapshot gần nhất. Nếu trang không đổi trạng thái, trả về `[SNAPSHOT_UNCHANGED]` thay vì 200 dòng text. | ~15 dòng code |
| **3. Stale Ref Guard** | Sống còn cho độ tin cậy của Agent | **P0 (Làm ngay)** | Dùng `documentId` + kiểm tra `!element.isConnected` trước action. Hỏng -> báo lỗi `STALE_REF` ngay, không click bừa. | ~20 dòng code |
| **4. Spring/Bezier Cursor** | Không tăng tỷ lệ hoàn thành task, làm chậm test | **Roadmap (OFF)** | Để nguyên click tức thì. Thêm cờ `humanizeCursor: false` trong options cho tương lai. | 0 dòng code |
| **5. Cập nhật AI Skill** | Bắt buộc để Agent biết cách khai thác hàm mới | **P0 (Làm ngay)** | Thêm hướng dẫn vào `.agents/skills/webmcp/SKILL.md` và `tool-reference-card.md` về cách xử lý `SNAPSHOT_UNCHANGED` và retry khi gặp `STALE_REF`. | Markdown doc |

---

## 3. Kế Hoạch Triển Khai Chi Tiết (Code Tối Giản)

### Giai đoạn 1 (P0): Chống Stale Ref & Tiết Kiệm Token (Triển khai trong ngày)

#### 1.1. Stale Ref Guard (Chặn click phần tử đã biến mất)
* **Vị trí:** `packages/webmcp-browser-kit/webmcp-extension/dist/content-scripts/aria-snapshot.js`
* **Vấn đề:** Khi React/Vue re-render, phần tử DOM cũ vẫn nằm trong `refToElement` nhưng đã bị tách khỏi cây DOM (`isConnected === false`).
* **Code tối giản:**
  ```javascript
  // Trong hàm resolveRef(ref) trước khi click/type:
  function getElementByRef(ref) {
    const weak = refToElement.get(ref);
    const el = weak?.deref();
    if (!el) {
      throw new Error(`REF_EXPIRED: Ref ${ref} no longer exists in memory.`);
    }
    if (!el.isConnected) {
      refToElement.delete(ref);
      throw new Error(`STALE_ELEMENT_REFERENCE: Element ${ref} was detached from DOM (page re-rendered). Please take a fresh getAriaSnapshot.`);
    }
    return el;
  }
  ```
* **Hiệu quả:** Loại bỏ 100% tình trạng click "vô hình" vào node chết.

#### 1.2. Unchanged State Short-Circuit (Tiết kiệm Token tức thì)
* **Vị trí:** `packages/webmcp-browser-kit/webmcp-extension/dist/content-scripts/aria-snapshot.js`
* **Vấn đề:** Khi agent gọi `getAriaSnapshot` lặp lại sau một thao tác chờ hoặc no-op, cả trang 2.000 tokens bị nạp lại vào context.
* **Code tối giản:**
  ```javascript
  let lastSnapshotText = '';
  let lastSnapshotUrl = '';

  function buildSnapshotWithCache(params) {
    const currentUrl = window.location.href;
    const currentText = buildSnapshot(params);

    if (currentUrl === lastSnapshotUrl && currentText === lastSnapshotText && !params.forceFresh) {
      return {
        text: `[SNAPSHOT_UNCHANGED: URL=${currentUrl}, elements unchanged since last step]`,
        unchanged: true
      };
    }

    lastSnapshotUrl = currentUrl;
    lastSnapshotText = currentText;
    return { text: currentText, unchanged: false };
  }
  ```
* **Hiệu quả:** Tiết kiệm ngay lập tức 100% token cho các turn polling / wait / verify trạng thái.

---

### Giai đoạn 2 (P1): Native CDP AX Engine (Chế độ High-Fidelity)

* **Vị trí:** `packages/webmcp-browser-kit/webmcp-extension/dist/bg/cdp-bridge.js`
* **Triết lý:** Không thay thế `aria-snapshot.js`. Giữ `aria-snapshot.js` làm chế độ mặc định (siêu nhanh, nhẹ). Thêm method `getCDPAriaSnapshot(tabId)` khi cần đọc Shadow DOM kín hoặc iframe sâu.
* **Luồng xử lý tối giản:**
  1. Gửi CDP command: `Accessibility.getFullAXTree({ depth: 10 })`.
  2. Map mảng `nodes` phẳng từ Chromium thành text thụt lề đơn giản:
     ```javascript
     export async function getCDPAriaSnapshot(tabId) {
       await ensureDebuggerAttached(tabId);
       const { nodes } = await sendCDPCommand(tabId, 'Accessibility.getFullAXTree', {});
       
       // Duyệt flat list và format trực tiếp, không tạo cây phức tạp
       const lines = [];
       let refCounter = 1;
       for (const node of nodes) {
         if (node.ignored || !node.role?.value) continue;
         const role = node.role.value;
         const name = node.name?.value ? `"${node.name.value}"` : '';
         const ref = `C${refCounter++}`; // C1, C2 cho CDP engine
         lines.push(`- ref=${ref} ${role} ${name}`);
       }
       return lines.join('\n');
     }
     ```
* **Hiệu quả:** Đạt chuẩn W3C 100% khi cần mà không tốn công cài đặt WASM.

---

### Giai đoạn 3 (Roadmap): Humanized Cursor Simulation
* **Trạng thái:** **Mặc định OFF (YAGNI).**
* **Quy tắc:** Chỉ mở ra khi có kịch bản automation cụ thể bị Cloudflare Turnstile hoặc Datadome chặn do click không có tọa độ chuột.

---

## 4. Kế Hoạch Cập Nhật Skill Cho AI Agent (Skill & Prompt Engineering)

Để AI Agent khi hoạt động trong workspace biết cách tận dụng các tính năng mới mà không bị lúng túng hoặc gọi sai cú pháp, cần cập nhật các file hướng dẫn cấp Agent.

### 4.1. Các file tài liệu Skill cần cập nhật:
1. `.agents/skills/webmcp/SKILL.md` (Tài liệu chỉ dẫn chính cho mọi Agent).
2. `packages/webmcp-browser-kit/skills/webmcp-browser-automation/references/tool-reference-card.md` (Bảng tra cứu nhanh lệnh).
3. `packages/webmcp-browser-kit/server/gateway/` (JSON Schema của tool `getAriaSnapshot`).

### 4.2. Nội dung bổ sung cụ thể vào `SKILL.md`:

```markdown
### 🟢 Quy tắc gọi `getAriaSnapshot` & Xử lý phản hồi tối ưu

1. **Nhận diện trạng thái `[SNAPSHOT_UNCHANGED]`:**
   - Nếu `getAriaSnapshot` trả về:
     `[SNAPSHOT_UNCHANGED: URL=..., elements unchanged since last step]`
   - **ĐIỀU CẤM:** KHÔNG ĐƯỢC gọi lại `getAriaSnapshot` liên tục trong vòng lặp!
   - **HÀNH ĐỘNG ĐÚNG:** Trạng thái trang web vẫn y hệt bước trước. Tiếp tục dùng các `ref` đã có ở lượt snapshot gần nhất để thực hiện bước kế tiếp.
   - Nếu bạn vừa click một nút và nghi ngờ trang đã đổi nhưng mạng lag chưa kịp tải, hãy đợi 1s (`delay: 1000`) rồi gọi `getAriaSnapshot({ forceFresh: true })`.

2. **Xử lý lỗi `STALE_ELEMENT_REFERENCE`:**
   - Nếu một thao tác (`clickByRef`, `typeByRef`) trả về lỗi:
     `STALE_ELEMENT_REFERENCE: Element R... was detached from DOM`
   - **Ý NGHĨA:** Trang web (React/Vue/Angular) vừa render lại DOM, phần tử cũ đã bị hủy và thay bằng phần tử mới.
   - **HÀNH ĐỘNG ĐÚNG:** Lập tức gọi `getAriaSnapshot({ forceFresh: true })` để lấy bảng `ref` mới nhất, sau đó tìm lại phần tử và click bằng ref mới. Tuyệt đối không retry lại ref cũ.

3. **Chọn Engine (`engine: "dom"` vs `engine: "cdp"`):**
   - Mặc định: Luôn để `engine: "dom"` (nhanh nhất, không cần quyền debugger).
   - Dùng `engine: "cdp"` khi: Trang web có Shadow DOM phức tạp (Web Components) hoặc iframes lồng sâu mà chế độ DOM không tìm thấy nút bấm.
```

---

## 5. Danh Sách File Cần Chạm & Kiểm Tra (Write-Set)

1. **Extension Code:**
   * [aria-snapshot.js](file:///Users/uyenuyen/Desktop/VIBE_CODE/webmcp-automation-kit/packages/webmcp-browser-kit/webmcp-extension/dist/content-scripts/aria-snapshot.js):
     - Thêm kiểm tra `!el.isConnected` trong `getElementByRef` (~15 dòng).
     - Thêm cache snapshot chuỗi trước đó cho `UNCHANGED` short-circuit (~15 dòng).
   * [cdp-bridge.js](file:///Users/uyenuyen/Desktop/VIBE_CODE/webmcp-automation-kit/packages/webmcp-browser-kit/webmcp-extension/dist/bg/cdp-bridge.js):
     - Thêm helper `getCDPAriaSnapshot` gọi trực tiếp `Accessibility.getFullAXTree` (~40 dòng).
2. **Skill & Docs (Cho AI Agent):**
   * [SKILL.md](file:///Users/uyenuyen/Desktop/VIBE_CODE/.agents/skills/webmcp/SKILL.md): Thêm mục hướng dẫn hành vi Agent cho `SNAPSHOT_UNCHANGED` và `STALE_ELEMENT_REFERENCE`.
   * [tool-reference-card.md](file:///Users/uyenuyen/Desktop/VIBE_CODE/webmcp-automation-kit/packages/webmcp-browser-kit/skills/webmcp-browser-automation/references/tool-reference-card.md): Thêm tham số `forceFresh` và `engine` vào dòng lệnh mẫu.
3. **Zero Dependencies:** Không thêm thư viện npm nào, không dùng WASM compiler, chạy thuần vanilla JS.
