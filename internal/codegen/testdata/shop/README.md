# Shop

<!-- Exported by opendesigner (opendesigner export): README of document "Shop" (shop). DO NOT edit by hand:
regenerate with `opendesigner export`. The data-node-id attribute ties every element to its design node. -->

React + TypeScript + Tailwind v4 project generated from the design with `opendesigner export`.

## Getting started

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # type check + production build
npx playwright install chromium   # first time only
npm test         # the e2e tests generated from the flows (playwright test)
```

## How the design becomes code

- Each **screen** (top-level frame) is a component in `src/screens/<Name>.tsx`; `src/App.tsx` mounts its routes (the frame's `meta["code.route"]`, otherwise the name's slug). The flow's start screen is also mounted on `/`.
- **Auto layout** -> flexbox (`flex`, `gap`, `padding`, `justify-*`, `items-*`); everything else is positioned absolutely (`absolute left-[..] top-[..]`) inside the container, using the design's coordinates. `hug` -> `fit-content`.
- Fills, strokes (inside/center/outside -> `box-shadow` rings), shadows, blurs, rotation, clipping, text and vectors follow **what the editor's canvas draws** (first fill, first shadow, first blur).
- **Images** are copied to `public/assets/<hash>.<ext>`; if missing, the canvas placeholder appears.
- Every element carries `data-node-id="<node id>"`: it is the link between the design and the code.
- Component **instances** are expanded inline (there is no extraction into React components yet).
- Screens have a fixed size (no responsiveness).

## Flows and tests

For each transition, the element that fires it (`elementId`) is clickable (`onClick` -> `navigate(...)`, `role="button"`, `aria-label` = label, `data-testid` from the `test.id` meta). Transitions without an element are visually hidden buttons in a transparent `<nav>` (1px, top-left). The `// flow: <id>`, `// guard:` and `// effect:` lines indicate the design's transition.

`tests/flows.spec.ts` is produced by `opendesigner flow tests` and walks all the flows' paths with Playwright.

## Screens

| Component | Route | Design node |
|---|---|---|
| `Login` | `/login` | `login` (Login) |
| `Home` | `/home` | `home` (Home) |
| `Detail` | `/detail` | `detail` (Detail) |

## Regenerating

```sh
opendesigner export -doc shop -target react -out . -force
```

The generated files must not be edited by hand: the next export overwrites them. To evolve the project by hand, export once and work on the code from then on (regeneration does not merge).
