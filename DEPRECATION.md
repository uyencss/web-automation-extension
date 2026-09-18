<!-- Prep branch: prep/project-commands-extraction. Gate opened 2026-09-18 (QĐ6 2/2). Shim NOT YET APPLIED — this file specifies the merge-phase contract. -->

# DEPRECATION CONTRACT: Browser Kit `project/` Shim

> **Initiative:** 2026-09-project-commands-extraction (Plan §5, §6, §8)  
> **Status:** DRAFT (requires named owner sign-off before merge gate opens)  
> **Canonical Target Location:** `packages/webmcp-browser-kit/DEPRECATION.md`

---

## 1. Shim Identification (Danh sách file là shim & bridge)

| File path | Status | Role during 30-day soak | Sunset action |
|---|---|---|---|
| `packages/webmcp-browser-kit/lib/cli/commands/project/index.mjs` | **ENTRYPOINT SHIM** | Emits stderr warning `deprecated: use webmcp project\n`; guards against re-entry loops (`WEBMCP_PROJECT_SHIM_ACTIVE`); handles `help` and `unknown` subcommands locally (mirroring canonical `index.mjs:141-144,159-161`); routes all legacy and bridge commands to real local implementations (`attach`, `list`, `where`, `doctor`, `charter`, `guide`, `schedule`, `content`, `policy`, `init`/`init-store`, `build-index`, `export-pack`); forwards `new` to hybrid `create.mjs`. | **DELETE FILE** |
| `packages/webmcp-browser-kit/lib/cli/commands/project/create.mjs` | **HYBRID SHIM** | Emits stderr warning `deprecated: use webmcp project new --archetype\n`; delegates `--archetype` to `webmcp-cli` / Project Kit; preserves real Runner code for `--template` and `--at` bootstrap intact (plan §1.2). | **PURGE ARCHETYPE BRANCH** (or delete entire file once `--template` migration initiative completes) |
| `packages/webmcp-browser-kit/lib/cli/commands/project/registry.mjs` | Bridge (retained) | Provides `runRunner`, `runProjectAttach`, `runProjectWhere`, `runProjectDoctor` for local Runner invocations during soak window. | **DELETE** when all runner delegations are extracted |
| `packages/webmcp-browser-kit/lib/cli/commands/project/charter-guide.mjs` | Thin bridge (retained) | Provides `runProjectCharter` and `runProjectGuide` forwarding to Runner `workspace charter\|guide`. | **DELETE** (or migrate to Runner directly) |
| `packages/webmcp-browser-kit/lib/cli/commands/project/schedule.mjs` | Real code (deferred) | Retained intact during window per plan §1.2. | Managed by separate `schedule` extraction initiative |
| `packages/webmcp-cli/lib/commands/project.mjs` | Upstream caller | Routes legacy subcommands via `delegateBrowser` (`:27-34, :362`). | **REMOVE `delegateBrowser`**; route directly to Runner / Project Kit |

---

### 1.1 Subcommand Dispatch Mapping during Soak Window (Local-thật vs Delegate)

Bảng phân định rõ ràng các nhánh xử lý trong `index.mjs` và `create.mjs` để tránh xóa âm thầm chức năng (fix blocker L2):

| Subcommand / Branch | Dispatch Type | Implementation / Target | Soak Window Status |
|---|---|---|---|
| `help` (bare, `--help`, `-h`, `help`) | **Local-thật (Terminal)** | `printProjectHelp()`, exit 0 (mirroring `index.mjs:141-144`) | Giữ local, triệt tiêu loop ping-pong với CLI `project.mjs:320-321` |
| `attach` | **Local-thật (Real / Bridge)** | `runProjectAttach(rest)` via `./registry.mjs` | Giữ nguyên code thật local |
| `list` | **Local-thật (Runner Bridge)** | `runRunner(['workspace', 'list', ...rest])` | Giữ nguyên bridge local |
| `where` | **Local-thật (Real / Bridge)** | `runProjectWhere(rest)` via `./registry.mjs` | Giữ nguyên code thật local |
| `doctor` | **Local-thật (Real / Bridge)** | `runProjectDoctor(rest)` via `./registry.mjs` | Giữ nguyên code thật local |
| `charter` | **Local-thật (Runner Bridge)** | `runProjectCharter(rest)` via `./charter-guide.mjs` | Giữ nguyên bridge local |
| `guide` | **Local-thật (Runner Bridge)** | `runProjectGuide(rest)` via `./charter-guide.mjs` | Giữ nguyên bridge local |
| `schedule` | **Local-thật (Deferred Code)** | `runProjectSchedule(rest)` via `./schedule.mjs` | Giữ nguyên code thật local (deferred §1.2) |
| `content` (`plan`, `apply`) | **Local-thật (Runner Bridge)** | `runProjectContent(rest)` via local helper + `runRunner` | Giữ nguyên code & bridge local |
| `policy` (`plan`, `apply`) | **Local-thật (Runner Bridge)** | `runProjectPolicy(rest)` via local helper + `runRunner` | Giữ nguyên code & bridge local |
| `init` / `init-store` | **Local-thật (Store Bridge)** | `runRunner(['project', 'init-store', ...rest])` | Giữ nguyên bridge local (R6.1) |
| `build-index` | **Local-thật (Store Bridge)** | `runRunner(['project', 'build-index', ...rest])` | Giữ nguyên bridge local (R6.1) |
| `export-pack` | **Local-thật (Store Bridge)** | `runRunner(['project', 'export-pack', ...rest])` | Giữ nguyên bridge local (R6.1) |
| `new --template <id>` | **Local-thật (Real Code)** | Runner `['workspace', 'project-new', ...]` via `./create.mjs` | Giữ nguyên code thật local |
| `new --at <dir>` (bootstrap) | **Local-thật (Real Code)** | Runner `['workspace', 'bootstrap', ...]` via `./create.mjs` | Giữ nguyên code thật local |
| **`new --archetype <id>`** | **DELEGATE (Project Kit)** | `spawn(process.execPath, [cliBin, 'project', 'new', ...args])` via `./create.mjs` | **Nhánh duy nhất delegate** sang WebMCP CLI / Project Kit (Plan §5) |
| `<unknown>` | **Local-thật (Terminal)** | `console.error` + `printProjectHelp()`, exit 2 (mirroring `index.mjs:159-161`) | Giữ local, bảo toàn Quirk 3, không fallback bừa sang CLI |

---

## 2. Deletion Deadline & Merge Policy

1. **Earliest Merge Date:** **2026-10-11** (Plan §6: soak period minimum 30 days from freeze). Merging before 2026-10-11 is strictly forbidden (`GATE MỞ MERGE`).
2. **Standard Deletion Deadline:** Exactly **30 calendar days** following the merge date.
   - *Example:* If merged on `2026-10-11T00:00:00Z`, the hard deletion deadline is `2026-11-10T00:00:00Z`.
   - *Exact formula:* `DELETION_DEADLINE = MERGE_TIMESTAMP + (30 * 86400 * 1000)`.

---

## 3. Responsible Owners (Chỉ định người chịu trách nhiệm)

Per plan §2, §5, and §6, no anonymous assignments are allowed. Placeholders below MUST be replaced with real named identities before opening the merge gate:

- **Primary Shim Purge Owner:** `[ASSIGN_SHIM_PURGE_OWNER_NAME]` (e.g., Lead Maintainer / Release Captain)
- **Designated Successor (Chống SPOF):** `[ASSIGN_SUCCESSOR_NAME]` (e.g., Secondary Reviewer / Team Lead)
- **Harness Retirement Owner:** `[ASSIGN_HARNESS_OWNER_NAME]` (retires `tests/fixtures/golden-project-template/` simultaneously with shim purge)

---

## 4. Hard Fallback Clause (Câu fallback cứng — QĐ5)

> **QUY TẮC BẮT BUỘC (FALLBACK KHÔNG THƯƠNG LƯỢNG):**  
> Nếu hết 30 ngày theo lịch (calendar days) kể từ thời điểm merge mà **chưa có ít nhất 1 bản phát hành stable (≥1 stable release)** mang stderr warning `deprecated: use webmcp project` đến tay người dùng cuối (downstream users), thì:
> 
> 1. **TUYỆT ĐỐI CẤM PURGE IM LẶNG (NO SILENT PURGE).**
> 2. Cơ chế xóa tự động chuyển đổi sang **release-based**: Shim PHẢI được duy trì qua ít nhất **2 bản minor stable releases** tiếp theo (ví dụ: phát hành trong `v1.5.0` thì shim chỉ được xóa tại `v1.7.0`).
> 3. Bắt buộc lập văn bản xác nhận (receipt) `receipt-sunset-fallback.json` có chữ ký của Primary Owner và Designated Successor ghi rõ lý do gia hạn và mốc release mới.

---

## 5. CI Flag: Automated Expired Shim Detection (Chống signer SPOF)

Để loại trừ rủi ro Single Point of Failure (SPOF) nếu người được chỉ định vắng mặt, CI workflow tự động kiểm tra hạn tồn tại của shim:

### 5.1 Workflow Configuration (`.github/workflows/check-shim-expiry.yml`)

```yaml
name: check-shim-expiry
on:
  schedule:
    - cron: '0 0 * * *' # Daily check
  pull_request:
    paths:
      - 'packages/webmcp-browser-kit/lib/cli/commands/project/**'
      - 'packages/webmcp-browser-kit/DEPRECATION.md'

jobs:
  verify-expiry:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Verify Shim Expiration
        run: |
          node scripts/ci/check-shim-deprecation.mjs \
            --manifest packages/webmcp-browser-kit/DEPRECATION.md \
            --enforce-stable-count 1
```

### 5.2 Verification Script Specification (`scripts/ci/check-shim-deprecation.mjs`)

The CI script verifies:
1. Parse merge commit date from git history (`git log -1 --format=%cI <merge-tag>`).
2. Calculate elapsed calendar days: `elapsedDays = (Date.now() - mergeDate) / (1000 * 60 * 60 * 24)`.
3. If `elapsedDays > 30`:
   - Query git tags for stable releases after merge commit: `git tag --list "v*" --contains <merge-commit>`.
   - If count of stable releases `< 1`:
     - Check if `receipt-sunset-fallback.json` exists with valid schema and approval signatures.
     - If receipt exists: emit notice `CI NOTICE: 30-day window passed without stable release; operating under approved 2-minor fallback policy.`
     - If receipt missing: **FAIL CI HARD** (`exit 1`) with message: `::error::Shim exceeded 30 days without stable release and no approved fallback receipt found!`.
   - If count of stable releases `≥ 1`:
     - Emit **BLOCKING ALERT**: `::error::Shim retention window expired! Purge PR must be opened immediately by [ASSIGN_SHIM_PURGE_OWNER_NAME] or [ASSIGN_SUCCESSOR_NAME].`
