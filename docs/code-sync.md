# Syncing components with the code

A Code Connect-style mapping between the design and the code project that implements it, plus a
drift report: which mapped files no longer match what the document exports. Implementation:
`internal/codesync` (pure), the CLI `opendesigner sync` and the MCP tools below.

## The mapping

It lives in node meta, so it travels with the document and needs no schema change:

| Key | Meaning |
|---|---|
| `code.file` | the implementing file, relative to the code project root (`src/ui/Button.tsx`) |
| `code.hash` | baseline: hash of the exported file when design and code were last reconciled |

Map any node of a component (a master, or a member of a variant set: the whole set is one file) or a
screen frame. The design side of the comparison is the file the export writes for that node, found by
the `data-node-id` the generators put on every element (`src/components/*`, `src/screens/*` for react,
the per-screen `.html` for html).

Paths must be relative and stay inside the project (`..` and absolute paths are refused).

## Statuses

| Status | Meaning |
|---|---|
| `in-sync` | the file equals the current export (line endings and trailing blank space ignored) |
| `design-changed` | the document moved since the baseline, the code did not: regenerate or port |
| `code-changed` | the code was edited since the baseline, the document did not |
| `diverged` | both moved |
| `drifted` | they differ and there is no baseline yet, so the side that moved is unknown |
| `missing` | the mapped file does not exist (or the path is invalid) |
| `not-exported` | the node produces no file (hidden, deleted, not inside a screen or component) |

`Detail` carries the first differing line. Components the export writes a file for that nothing maps to
are listed as `unmapped`.

## MCP

- `map_component_code {nodeId, file}`: set `code.file` (empty `file` removes the mapping and baseline).
- `check_code_sync {dir, target?}`: the report. `target` is `react` (default) or `html`.
- `accept_code_sync {dir, target?, nodeIds?}`: after reconciling, record the current export as the baseline.

## CLI

```
opendesigner sync -doc "Shop" -dir ./my-app            # text report
opendesigner sync -json shop.json -dir . -format json  # for CI
```

Exit status 0 in sync, 1 drift, 2 error: usable as a CI gate. The CLI opens the document offline and
read-only, like `export` and `flow`; recording a baseline writes the document, so it is an MCP action.

## Limits

- The comparison is textual against the generator's output, so a project that hand-edits generated
  files reads as drifted by design; the baseline tells which side moved, not whether the edit matters.
- Only the `react` and `html` targets are compared; the native targets (SwiftUI, Compose, Leptos) lay
  files out differently and are not resolved yet.
- No editor UI: mapping and the report are CLI/MCP only.
