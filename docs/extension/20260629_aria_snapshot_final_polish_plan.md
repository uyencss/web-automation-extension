# ARIA Snapshot Final Polish Implementation Plan

Date: 2026-06-29

## Goal

Close the remaining token-efficiency and page-structure gaps in fast ARIA
snapshot output:

- Inline native select/options so agents can choose dropdown values without an
  extra query.
- Reduce fast ref token overhead while keeping frame-aware refs.
- Add an explicit `maxChars` guard that fails gracefully before returning an
  oversized snapshot.

## Design

### 1. Inline Select/Option Rendering

Default behavior:

- `includeOptions: true`
- `maxOptions: 50`

For each visible `<select>` included in the snapshot, render child `option`
lines under the `combobox`/`listbox` line:

```text
- ref=r3 combobox "Country" value="US"
  - option "US" value="US" [selected]
  - option "Canada" value="CA"
```

If a select has more than `maxOptions`, append a compact truncation note:

```text
  - note "17 more options truncated"
```

The option list is bounded so large country/product dropdowns cannot dominate
the snapshot.

### 2. Compact Fast Refs

Fast refs are still stored in content scripts as stable `R<number>` refs. The
background formatter presents them more compactly:

- Main frame: `ref=r1`
- Child frame: `ref=f3r1`

Backward compatibility:

- Accept old qualified refs: `F0:R1`, `F3:R1`
- Accept old local refs: `R1`
- Accept new compact refs: `r1`, `f3r1`
- Native CDP refs remain `S1`

Callers can request `refFormat: "qualified"` to receive the older
`F0:R1`-style display format.

### 3. Explicit `maxChars`

`getAriaSnapshot` accepts `maxChars`.

If the generated snapshot exceeds the limit:

- Return a structured, graceful error instead of returning the huge snapshot.
- Include `actualChars`, `maxChars`, and practical guidance to lower
  `maxNodes`, lower `maxDepth`, use `scope: "viewport"`, or raise `maxChars`.
- Do not silently fall back from fast to native when the fast path reports a
  deliberate size-limit error, because native is usually larger.

Native CDP fallback gets the same `maxChars` guard after formatting.

## Tasks

1. Add bounded option-line formatting in the content-script snapshot walker.
2. Add `includeOptions`, `maxOptions`, `maxChars`, and `refFormat` params.
3. Compact fast ref display in the background handler.
4. Extend fast-ref parsing to support compact refs and legacy refs.
5. Add structured too-large errors for fast and native paths.
6. Update command catalog, generated references, README, and skill docs.
7. Verify JavaScript syntax, tool reference generation, and extension build.
