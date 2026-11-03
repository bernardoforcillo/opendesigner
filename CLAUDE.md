# Development rules

Go backend (`cmd/`, `internal/`), React + Vite frontend (`web/`), protobuf contracts (`proto/`).
The server binary embeds the built frontend from `web/dist`.

## Commands

| Task | Command |
| --- | --- |
| Dev loop (backend + embedded web, reloads on Go and `web/src` edits) | `air` |
| Frontend dev server (proxies RPC to `localhost:8080`, so the backend must run there) | `pnpm --dir web dev` |
| Type-check the frontend | `pnpm --dir web exec tsc -b` |
| Frontend tests | `pnpm --dir web test` |
| Go tests | `go test ./...` |
| Regenerate protobuf code | `buf generate` |

Before calling a change done, run the type check and the tests for every side you touched.

## Frontend (`web/src`)

### Imports

- Import through an alias, never a relative path: `@/` for `src`, `@features/` for `src/features`.
  `import { Icon } from "@/ui/ds"`, `import { HomePage } from "@features/home"`.
- These two are the only aliases. Do not add more to `tsconfig.json` or `vite.config.ts`.
- The single exception is a worker URL, which Vite needs relative:
  `new URL("./wasmWorker.ts", import.meta.url)`.

### Where code goes

- Feature code lives in `src/features/<feature>/`:
  - `components/{atoms,molecules,organisms}/<Name>/index.tsx`
  - `pages/<Name>Page/index.tsx`
  - `scripts/<name>/index.ts` for node scripts, run by `package.json`
  - `index.ts`, the feature's public barrel
- Components used by more than one feature go in `src/shared/components/{atoms,molecules,organisms}/<Name>/index.tsx`.
- A module that grows into a folder becomes `<module>/index.ts`, with its test beside it as `index.test.ts`.
- Older paths such as `src/home/Home.tsx` or `src/flow/camera.ts` are now one-line re-exports.
  New code imports from the new location. Do not add code to those files, and do not add new ones.

### React

- Call every hook before any early `return`. A hook after `if (!scene) return null` runs a
  different number of hooks once the document loads, and React throws error #310, which
  takes down the whole editor. `PageBar` shipped exactly this bug.
- User-facing text goes through `useT()` from `@/i18n`. Add new keys to `i18n/locales/en.ts`.

### Tests

- Vitest with Testing Library; the shared setup is in `src/test/setup.ts`.
- Put tests next to the code they cover, and add or update one whenever behaviour changes.

## Backend and contracts

- Change contracts in `proto/opendesigner/v1`, then run `buf generate`. Commit the generated
  `gen/` (Go) and `web/src/gen` (TypeScript) together with the `.proto` change.
- Never edit generated files by hand.

## Repository hygiene

- `web/dist/.gitkeep` is tracked, because `//go:embed all:dist` needs the folder in a clean
  checkout. Vite deletes it on every build: restore it with `git checkout -- web/dist/.gitkeep`
  and never commit the deletion.
- Commits follow Conventional Commits, `type(scope): subject`, with a body that explains why.
  Keep each commit to one logical change.
- Work on a branch and merge into `main` with a merge commit.
