# Animations

<!-- Exported by opendesigner (opendesigner export): README of document "Animations" (anim). DO NOT edit by hand:
regenerate with `opendesigner export`. The data-node-id attribute ties every element to its design node. -->

React + TypeScript + Tailwind v4 project generated from the design with `opendesigner export`.

## Getting started

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # type check + production build
```

## How the design becomes code

- Each **screen** (top-level frame) is a component in `src/screens/<Name>.tsx`; `src/App.tsx` mounts its routes (the frame's `meta["code.route"]`, otherwise the name's slug). The flow's start screen is also mounted on `/`.
- **Auto layout** -> flexbox (`flex`, `gap`, `padding`, `justify-*`, `items-*`); everything else is positioned absolutely (`absolute left-[..] top-[..]`) inside the container, using the design's coordinates. `hug` -> `fit-content`.
- Fills, strokes (inside/center/outside -> `box-shadow` rings), shadows, blurs, rotation, clipping, text and vectors follow **what the editor's canvas draws** (first fill, first shadow, first blur).
- **Images** are copied to `public/assets/<hash>.<ext>`; if missing, the canvas placeholder appears.
- Every element carries `data-node-id="<node id>"`: it is the link between the design and the code.
- Component **instances** are expanded inline (there is no extraction into React components yet).
- Screens have a fixed size (no responsiveness).

## Animations

The design's **clips** become animations with [Motion](https://motion.dev) (`import { motion } from "motion/react"`): every element with tracks is a `motion.div` (or `motion.svg`/`motion.path`) with a `<name>Variants` constant, and its **target** carries the labels that fire them on descendants.

- `enter` -> `initial="initial" animate="animate"` (starts on mount); `loop` -> like enter but with `repeat: Infinity` (`repeatType: "reverse"` if yoyo); `hover` -> `whileHover="hover"`; `tap` -> `whileTap="tap"`.
- `x`/`y` are **deltas** from the design position, `rotate` is a delta in degrees (composes with the base rotation), `scale` is a multiplier, `opacity` is absolute, `draw` -> `pathLength` (0..1) of a vector's stroke.
- Each property has its own keyframes (`[..]`), `times` (0..1 of the clip) and one `ease` per segment; `spring` is approximated by a Bézier curve.
- A **manual** clip does not start on its own: it has a variant with the name given in the table; to start it set `animate="<variant>"` on the target element (usually from React state) or drive it with `useAnimate`.

| Clip | Trigger | Target | Duration | Variant |
|---|---|---|---|---|
| draw the signature | enter | `logo` | 1200 ms | `animate` |
| enter | enter | `scr` | 800 ms | `animate` |
| highlight | manual | `card` | 300 ms | `highlight` |
| hover | hover | `btn` | 200 ms | `hover` |
| loading | loop | `spin` | 1000 ms | `animate` |
| press | tap | `btn` | 100 ms | `tap` |
| tilt | hover | `tilt` | 300 ms | `hover` |

## Screens

| Component | Route | Design node |
|---|---|---|
| `Animations` | `/` | `scr` (Animations) |

## Regenerating

```sh
opendesigner export -doc anim -target react -out . -force
```

The generated files must not be edited by hand: the next export overwrites them. To evolve the project by hand, export once and work on the code from then on (regeneration does not merge).
