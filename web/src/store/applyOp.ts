import { create } from "@bufbuild/protobuf";
import { NodeSchema } from "@/gen/opendesigner/v1/opendesigner_pb";
import type { Node as PbNode, Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { isValidEasing } from "@/animation/engine";
import { isValidClip } from "@/animation/validate";
import { type SceneState, type ClipLite, toPaintStyleDefLite, toEffectStyleDefLite, toComponentPropertyLite, toComponentSetLite, toCollectionLite, toVariableLite, toFontLite, toTextStyleDefLite, type NodeLite, type TransitionLite, TRANSITION_ANIMATIONS, MAX_TRANSITION_ORDER, toFlowLite, toClipLite, toTransitionLite, toAnnotationLite, toReadyLite, toCommentLite, toNodeLite, toTextStyleLite, toSubPathsLite, toInstanceOverrideLite, toInstanceLite, toObjectStyleLite, toLayerLite } from "@/store/types";
import { type MaskPath, isMaskPath } from "@/store/maskPaths";
import { layoutTargets, relayout, resizeChildren } from "@/store/layout";
import { recordDelta } from "@/store/sceneDelta";
import { carryRenames, cascadeComponentTargets, detachInvalidMembers, isValidComponentDef, isValidComponentSet, isValidInstanceProps, makeRenamer } from "@/store/components";
import { isValidFont, isValidTextStyleDef, isValidTextStyleId, unstyleNodes } from "@/store/typography";
import { detachNodes, isValidLayer, isValidLayerId, isValidObjectStyle, isValidObjectStyleId } from "@/store/graphics";
import { areValidLayoutGrids } from "@/store/layoutGrids";
import { isValidGridCell, isValidGridLayout } from "@/store/layoutGrid";
import { areValidEffects } from "@/store/effects";
import { arePaintsValid } from "@/store/paints";
import { areStrokeExtrasValid, isValidShape, isValidShapePath, SHAPE_PATHS, writeShapePath } from "@/store/shapes";
import { isValidEffectStyleDef, isValidPaintStyleDef, isValidStyleId, STYLE_PATHS, unstyleNodesByPaint } from "@/store/paintStyles";
import { isValidComment, withoutComment } from "@/store/comments";
import { annotationsOfScene, isValidAnnotation, isValidReady, readyOfScene } from "@/store/devMode";
import { areValidBindings, areValidModes, dropRemovedModes, isValidCollection, isValidVariable, unbindNodes, withAliases } from "@/store/variables";
import { childrenOf, isAncestorOf, parentExists, subtreeOf } from "@/store/tree";
import { isValidInstanceBody } from "@/store/instanceOps";
import { clampRich, isValidRich, richFields } from "@/store/richText";
import { isValidDocSettings, isValidPageSetup, toDocSettings } from "@/store/docSettings";
import { deletePageAllowed, masterFieldsValid, pageOf, updatePageAllowed } from "@/store/masters";

// A SetProperties WITHOUT a patch is NOT a no-op. Go reads the patch with protobuf's
// nil-safe getters (`p.GetX()` on a nil *Node returns the field's zero),
// so applySetProps ZEROES the fields listed in the mask. This all-zero
// node makes that behavior explicit instead of silently diverging
// from the server. Shared across calls: applyOp is pure and does not mutate it.
const NIL_PATCH: PbNode = create(NodeSchema, {});

// The size-limit mask paths and the NodeLite / Node field each one writes.
const camelLimit = { min_width: "minWidth", max_width: "maxWidth", min_height: "minHeight", max_height: "maxHeight" } as const;

// applyOp is pure: it does NOT mutate state, it returns a new object. Parity with core.Apply (Go).
//
// After the op it re-lays out the auto layout frames it may have touched, as
// core.Apply does: the affected frames are read both BEFORE the op (the old
// parent of a deleted or moved node) and AFTER (the new one). See
// store/layout.ts.
export function applyOp(state: SceneState, op: Op): SceneState {
  const before = layoutTargets(state, op);
  const next = applyOpRaw(state, op);
  if (next === state) return state;
  const touchedByLayout: string[] = [];
  const laidOut = relayout(next, [...before, ...layoutTargets(next, op)], touchedByLayout);
  // Ops that touch a single known node declare which one: whoever maintains derived
  // structures (renderer/sceneIndex.ts) need not compare the whole
  // scene to find out. The others (delete, reparent, pages,
  // components) do not record it and fall back to the full comparison.
  const id = singleTouchedNode(op, state);
  if (id !== null) recordDelta(laidOut, state, [id, ...touchedByLayout]);
  return laidOut;
}

// The only node the op writes, if it writes exactly one.
function singleTouchedNode(op: Op, state: SceneState): string | null {
  const k = op.kind;
  switch (k.case) {
    case "createNode": return k.value.node?.id ?? null;
    // Resizing a frame also moves its children (constraints): no single node to name.
    case "setProps": {
      const resizes = (k.value.mask?.paths ?? []).some((p) => p === "width" || p === "height");
      return resizes && state.nodes.at(k.value.id)?.kind === "frame" ? null : k.value.id;
    }
    case "setText": return k.value.id;
    case "setVectorPath": return k.value.id;
    case "setImage": return k.value.id;
    default: return null;
  }
}

function applyOpRaw(state: SceneState, op: Op): SceneState {
  switch (op.kind.case) {
    case "createNode": {
      const pb = op.kind.value.node;
      // Parity with core.applyCreate (Go): absent node or empty id =
      // ErrNilNode, id ALREADY PRESENT = ErrNodeExists. The server rejects the op
      // as a whole in both cases, so here we do not create and above all do not
      // OVERWRITE: a client that overwrites locally silently diverges
      // from the authoritative document (and the undo of that op would be the undo of
      // something the server never accepted).
      if (!pb || pb.id === "" || state.nodes.at(pb.id)) return state;
      if (!arePaintsValid(pb.fills, pb.strokes)) return state;                // ErrPaint
      if (!isValidShape(pb) || !areStrokeExtrasValid(pb.strokes)) return state;  // ErrShapeValue / ErrStrokeExtra
      // The parent must EXIST (another node, or a Page for roots):
      // ErrParentNotFound in core.applyCreate (Go). A node with a nonexistent
      // parent is not reachable from any page -- invisible on the
      // canvas and in the layers panel, but present in the map -- and the server
      // rejected it anyway: creating it here is the usual silent divergence.
      if (!parentExists(state, pb.parentId)) return state;
      if (!isValidStyleId(state, "fill_style_id", pb.fillStyleId) || !isValidStyleId(state, "stroke_style_id", pb.strokeStyleId)
        || !isValidStyleId(state, "effect_style_id", pb.effectStyleId)) return state;   // ErrPaintStyleMissing
      // An INSTANCE must reference an EXISTING component: parity with
      // core.applyCreate (Go), which replies ErrComponentNotFound. Without it, the instance
      // would render nothing -- its subtree is derived from the master -- and the
      // server rejected it anyway: creating it here is the same silent divergence
      // as the parent/id-already-taken branches. Order as in Go: first the
      // parent, then the component.
      if (pb.shape.case === "instance" && !state.components[pb.shape.value.componentId]) return state;
      return { ...state, nodes: state.nodes.set(pb.id, toNodeLite(pb)) };
    }
    case "setProps": {
      const { id, patch, mask } = op.kind.value;
      const cur = state.nodes.at(id);
      // Nonexistent node = ErrNodeNotFound in Go: op rejected, scene
      // unchanged. A missing patch instead does NOT stop the op (see NIL_PATCH).
      if (!cur) return state;
      const p = patch ?? NIL_PATCH;
      const paths = mask?.paths ?? [];
      // Parity with core.applySetProps (Go): validates the WHOLE mask before
      // mutating any field. If even a single path is unsupported,
      // the whole op is rejected (state unchanged) -- not partially
      // applied. A mixed mask (e.g. ["x","someFutureField"]) must never
      // mutate "x" while silently discarding the unknown path.
      // isMaskPath comes from ./maskPaths -- the ONLY source of truth, shared
      // with tools/ops.ts::makeSetPropsOp, which mirrors the switch of
      // core.applySetProps (Go). paths here is what arrives FROM AN already
      // decoded Op (local or from the wire via Subscribe): a runtime check
      // remains necessary even with the compile-time MaskPath type at the
      // construction points, because nothing guarantees at runtime that an Op received
      // from the wire respects that type.
      if (!paths.every(isMaskPath)) return state;
      // Second PREVENTIVE validation, for the same reason as the first:
      // "corner_radius" is the only path that addresses a field INSIDE the `shape`
      // oneof (RectNode.corner_radius), so it is the only one that can find the
      // node of the wrong shape. Go replies ErrNotRectNode and rejects the WHOLE
      // op (internal/core/apply.go), so a mixed mask
      // (e.g. ["x","corner_radius"]) on an ellipse must not even move
      // x. Note that kind "rect" also includes the node WITHOUT a shape (see
      // toNodeLite): Go accepts it the same way, materializing the
      // implicit rectangle.
      //
      // And it is a WHITELIST exactly like Go's, not "everything except
      // ellipse and text": kindOf (store/types.ts) maps to "unknown" every shape
      // this model does not know, so a shape added by another track
      // is rejected by default HERE as it is over there. With the old
      // "unknown => rect" fallback this line let it through and Go
      // replied ErrNotRectNode: the client/authoritative document divergence
      // the whitelist exists to prevent, only from the other side of the wire.
      if (cur.kind !== "rect" && paths.includes("corner_radius")) return state;
      // Same preventive validation for auto_layout, which only applies to a
      // frame (ErrNotFrameNode in Go): op rejected as a whole.
      if (cur.kind !== "frame" && paths.includes("auto_layout")) return state;
      // Variable bindings and mode pins are validated against the document before
      // anything is written (core.applySetProps does the same in its validation
      // pass): a mixed mask with one bad entry must not move the other fields.
      if (paths.includes("bindings") && !areValidBindings(state, p.bindings)) return state;
      if (paths.includes("modes") && !areValidModes(state, p.modes)) return state;
      if (paths.includes("text_style_id") && !isValidTextStyleId(state, cur, p.textStyleId)) return state;
      if (paths.includes("object_style_id") && !isValidObjectStyleId(state, cur, p.objectStyleId)) return state;
      if (paths.includes("layer_id") && !isValidLayerId(state, p.layerId)) return state;
      // The enums are closed: an out-of-range number is rejected whole (core.applySetProps).
      if (paths.includes("constraint_x") && !(p.constraintX >= 0 && p.constraintX <= 5)) return state;
      if (paths.includes("constraint_y") && !(p.constraintY >= 0 && p.constraintY <= 5)) return state;
      if (paths.includes("layout_grids") && (cur.kind !== "frame" || !areValidLayoutGrids(p.layoutGrids))) return state;
      if ((paths.includes("fills") || paths.includes("strokes")) && !arePaintsValid(p.fills, p.strokes)) return state;
      // Shape-parameter paths apply only to the shape that owns the field (core.checkShapePath).
      if (paths.some((path) => SHAPE_PATHS.has(path) && !isValidShapePath(cur, p, path))) return state;
      if (paths.includes("strokes") && !areStrokeExtrasValid(p.strokes)) return state;
      if (paths.some((path) => STYLE_PATHS.has(path) && !isValidStyleId(state, path, path === "fill_style_id" ? p.fillStyleId : path === "stroke_style_id" ? p.strokeStyleId : p.effectStyleId))) return state;
      if (paths.includes("blend_mode") && !(p.blendMode >= 0 && p.blendMode <= 15)) return state;
      if (paths.includes("effects") && !areValidEffects(p.effects)) return state;
      if (paths.includes("layout_sizing_x") && !(p.layoutSizingX >= 0 && p.layoutSizingX <= 1)) return state;
      if (paths.includes("layout_sizing_y") && !(p.layoutSizingY >= 0 && p.layoutSizingY <= 1)) return state;
      for (const lim of ["min_width", "max_width", "min_height", "max_height"] as const) {
        if (paths.includes(lim) && !(Number.isFinite(p[camelLimit[lim]]) && p[camelLimit[lim]] >= 0)) return state;
      }
      if (paths.includes("layout_positioning") && !(p.layoutPositioning >= 0 && p.layoutPositioning <= 1)) return state;
      if (paths.includes("grid_cell") && !isValidGridCell(p.gridCell)) return state;
      if (paths.includes("auto_layout") && !isValidGridLayout(p.shape.case === "frame" ? p.shape.value.autoLayout : undefined)) return state;
      const next: NodeLite = { ...cur };
      for (const path of paths as readonly MaskPath[]) {
        switch (path) {
          case "x": next.x = p.x; break;
          case "y": next.y = p.y; break;
          case "width": next.width = p.width; break;
          case "height": next.height = p.height; break;
          case "rotation": next.rotation = p.rotation; break;
          case "opacity": next.opacity = p.opacity; break;
          case "name": next.name = p.name; break;
          case "visible": next.visible = p.visible; break;
          case "layout_grids": {
            const g = toNodeLite(p).layoutGrids;
            if (g) next.layoutGrids = g; else delete next.layoutGrids;
            break;
          }
          case "is_mask": if (p.isMask) next.isMask = true; else delete next.isMask; break;
          case "fills": next.fills = toNodeLite(p).fills; break;
          // REPLACEMENT of the whole list, like "fills" and like `n.Strokes =
          // p.GetStrokes()` in core.applySetProps (Go): never a merge
          // element by element. A patch WITHOUT strokes zeroes the list --
          // it is Go's nil-safe getter, and it is also how the properties
          // panel removes the stroke from a node (see NIL_PATCH above).
          case "strokes": next.strokes = toNodeLite(p).strokes; break;
          // Replacement of the whole list like `n.Effects = p.GetEffects()` in
          // Go. An empty list REMOVES the field (NodeLite.effects is absent, not
          // empty, when there are no effects).
          case "effects": {
            const fx = toNodeLite(p).effects;
            if (fx) next.effects = fx; else delete next.effects;
            break;
          }
          // The path is snake_case (the .proto and Go convention), the model's
          // field is camelCase: the two forms coincided for all the single-word
          // paths of M0/M1a, this is the first where they diverge.
          case "order_key": next.orderKey = p.orderKey; break;
          // Replaces the whole map (like `n.Meta = p.GetMeta()` in Go); an empty
          // map REMOVES the field (NodeLite.meta is absent, not empty).
          case "meta": {
            const m = toNodeLite(p).meta;
            if (m) next.meta = m; else delete next.meta;
            break;
          }
          // Like meta: replaces the whole map, and an empty map removes the field.
          case "bindings": {
            const b = toNodeLite(p).bindings;
            if (b) next.bindings = b; else delete next.bindings;
            break;
          }
          case "modes": {
            const m = toNodeLite(p).modes;
            if (m) next.modes = m; else delete next.modes;
            break;
          }
          case "text_style_id": {
            if (p.textStyleId !== "") next.textStyleId = p.textStyleId; else delete next.textStyleId;
            break;
          }
          case "fill_style_id": if (p.fillStyleId !== "") next.fillStyleId = p.fillStyleId; else delete next.fillStyleId; break;
          case "stroke_style_id": if (p.strokeStyleId !== "") next.strokeStyleId = p.strokeStyleId; else delete next.strokeStyleId; break;
          case "effect_style_id": if (p.effectStyleId !== "") next.effectStyleId = p.effectStyleId; else delete next.effectStyleId; break;
          case "corner_smoothing": case "radii": case "arc_start": case "arc_sweep": case "inner_ratio": case "sides": case "points":
            writeShapePath(next, p, path);
            break;
          case "object_style_id": {
            if (p.objectStyleId !== "") next.objectStyleId = p.objectStyleId; else delete next.objectStyleId;
            break;
          }
          case "layer_id": {
            if (p.layerId !== "") next.layerId = p.layerId; else delete next.layerId;
            break;
          }
          // Through toNodeLite, like the other enums: UNSPECIFIED / FIXED remove the field.
          case "constraint_x": {
            const c = toNodeLite(p).constraintX;
            if (c) next.constraintX = c; else delete next.constraintX;
            break;
          }
          case "constraint_y": {
            const c = toNodeLite(p).constraintY;
            if (c) next.constraintY = c; else delete next.constraintY;
            break;
          }
          case "blend_mode": {
            const b = toNodeLite(p).blendMode;
            if (b) next.blendMode = b; else delete next.blendMode;
            break;
          }
          case "layout_sizing_x": {
            const c = toNodeLite(p).layoutSizingX;
            if (c) next.layoutSizingX = c; else delete next.layoutSizingX;
            break;
          }
          case "layout_sizing_y": {
            const c = toNodeLite(p).layoutSizingY;
            if (c) next.layoutSizingY = c; else delete next.layoutSizingY;
            break;
          }
          // The limits and the positioning go through toNodeLite too: 0 / AUTO remove the field.
          case "min_width": case "max_width": case "min_height": case "max_height": {
            const key = camelLimit[path];
            const v = toNodeLite(p)[key];
            if (v) next[key] = v; else delete next[key];
            break;
          }
          case "layout_positioning": {
            const c = toNodeLite(p).layoutPositioning;
            if (c) next.layoutPositioning = c; else delete next.layoutPositioning;
            break;
          }
          case "grid_cell": {
            const c = toNodeLite(p).gridCell;
            if (c) next.gridCell = c; else delete next.gridCell;
            break;
          }
          // As for "fills", the value is extracted from the patch by going through
          // toNodeLite instead of reading it by hand: it is the SAME function that
          // translates a wire Node, so a patch without rect falls back to
          // zero exactly as Go's nil-safe getter `p.GetRect()
          // .GetCornerRadius()` does, without a second rule to keep
          // aligned.
          case "corner_radius": next.cornerRadius = toNodeLite(p).cornerRadius; break;
          // The value comes from the patch NESTED in the frame shape, going through
          // toNodeLite as for corner_radius. A patch without frame (or without
          // auto_layout) turns it off -- like Go's nil-safe getter -- and the field
          // disappears from the node instead of staying "off".
          case "auto_layout": {
            const al = toNodeLite(p).autoLayout;
            if (al) next.autoLayout = al; else delete next.autoLayout;
            break;
          }
          default: {
            // Compile-time guard: if MASK_PATHS gains a member without
            // a case above, this line stops compiling instead of
            // silently discarding the new path at runtime. "Impossible to
            // forget a case" is the complement of "impossible to build
            // an invalid path" (that one is ops.ts::makeSetPropsOp).
            const exhaustive: never = path;
            return exhaustive;
          }
        }
      }
      const written: SceneState = { ...state, nodes: state.nodes.set(id, next) };
      // A resized frame moves and resizes its children by their constraints (a frame with
      // auto layout decides for itself): core.applySetProps does the same.
      if (next.width !== cur.width || next.height !== cur.height) {
        const edit = written.nodes.edit();
        if (resizeChildren(written, edit, id, cur.width, cur.height)) return { ...written, nodes: edit.done() };
      }
      return written;
    }
    // Dedicated op and not a setProps mask path: the content lives
    // INSIDE the Node's `shape` oneof, while the mask addresses top-level
    // fields. Parity with core.applySetText (Go).
    case "setText": {
      const { id, content, style, stylePresent } = op.kind.value;
      const cur = state.nodes.at(id);
      // Nonexistent node = ErrNodeNotFound in Go.
      if (!cur) return state;
      // Non-text node = ErrNotTextNode in Go: the op is rejected as a whole.
      // Writing a `text` into it would turn the node's shape locally
      // (a rectangle turned into text) while the server rejected it.
      if (cur.kind !== "text" || !cur.text) return state;
      // The content is ALWAYS written (even empty: it is the deleted text).
      // The style only if stylePresent: the flag distinguishes "unspecified" from
      // "reset" (in proto3 an absent style and an all-zero one are not
      // distinguishable after the protojson round-trip, so without the flag every
      // keystroke would bring the font to 0). The flag takes precedence
      // over the presence of the sub-message: a `style` with stylePresent=false
      // must be ignored, exactly as Go does, reading only GetStylePresent().
      const { paragraphStyles, runs, richPresent } = op.kind.value;
      // Rich text (parity with core.applySetText): with richPresent the lists replace the node's and are
      // validated first -- a rejection changes nothing; without it they follow the new content.
      if (richPresent && !isValidRich(state, content, paragraphStyles, runs)) return state;
      const base = {
        content,
        style: stylePresent ? toTextStyleLite(style) : cur.text.style,
      };
      const text = richPresent
        ? { ...base, ...richFields(paragraphStyles, runs) }
        : clampRich({ ...base, ...(cur.text.paragraphStyles ? { paragraphStyles: cur.text.paragraphStyles } : {}), ...(cur.text.runs ? { runs: cur.text.runs } : {}) });
      return { ...state, nodes: state.nodes.set(id, { ...cur, text }) };
    }
    // Dedicated op and not a mask path, for the same reason as setText: the
    // geometry lives INSIDE the `shape` oneof. Parity with core.applySetVectorPath (Go).
    // Relink: the source of an image node. Parity with core.applySetImage.
    case "setImage": {
      const { id, image } = op.kind.value;
      const cur = state.nodes.at(id);
      if (!cur || cur.kind !== "image" || !image) return state;                // ErrNodeNotFound / ErrNotImageNode
      // eslint-disable-next-line no-control-regex
      if (image.originalName.length > 255 || /[\u0000-\u001f\u007f]/.test(image.originalName) || image.pixelWidth > 1048576 || image.pixelHeight > 1048576) return state;
      return { ...state, nodes: state.nodes.set(id, { ...cur, image: toNodeLite(create(NodeSchema, { shape: { case: "image", value: image } })).image }) };
    }
    case "setVectorPath": {
      const { id, subpaths } = op.kind.value;
      const cur = state.nodes.at(id);
      // Nonexistent node = ErrNodeNotFound in Go.
      if (!cur) return state;
      // Non-vector node = ErrNotVectorNode in Go: the op is rejected as a
      // whole. Note that the "kind rect also includes the node without
      // shape" fallback of corner_radius does NOT apply here: that node is a RECTANGLE for
      // both sides, so it is exactly the case to reject.
      if (cur.kind !== "vector" || !cur.vector) return state;
      // The list is ALWAYS written, even empty: it is the path the user
      // emptied, not an "unspecified" to ignore. No `present` flag
      // like stylePresent -- there it was needed because a setText carries two things and one
      // had to be able to stay intact; here the op IS the subpaths.
      return {
        ...state,
        nodes: state.nodes.set(id, { ...cur, vector: { subpaths: toSubPathsLite(subpaths) } }),
      };
    }
    // Deletes the node AND ITS WHOLE subtree. Parity with core.applyDelete
    // (Go): without the cascade the children would stay in the map with a parentId
    // that no longer exists -- the same orphans the createNode branch above
    // refuses to create.
    case "deleteNode": {
      const { id } = op.kind.value;
      // Nonexistent id = ErrNodeNotFound in Go: op rejected, scene unchanged
      // (and no new object, so selectors do not wake up for nothing).
      if (!state.nodes.at(id)) return state;
      const nodes = state.nodes.edit();
      const gone = new Set<string>();
      for (const n of subtreeOf(state, id)) { nodes.delete(n.id); gone.add(n.id); }
      return { ...state, nodes: nodes.done(), ...cascadeFlows(state, gone), ...cascadeClips(state, gone), ...cascadeComponentTargets(state, gone) };
    }
    // Dedicated op and not a setProps mask path (unlike
    // `order_key`) because it has a validation no field has: the new
    // parent must exist and cannot be the node itself nor one of its
    // descendants. Parity with core.applyReparent (Go).
    case "reparentNode": {
      const { id, newParentId, orderKey } = op.kind.value;
      const cur = state.nodes.at(id);
      if (!cur) return state;                                   // ErrNodeNotFound
      if (!parentExists(state, newParentId)) return state;      // ErrParentNotFound
      // A cycle would detach the subtree from the document (no page would
      // reach it anymore) while leaving it in the map: invisible and not
      // deletable. The node itself is the degenerate case -- isAncestorOf is
      // strict -- so it must be excluded separately. ErrCycle in Go.
      if (newParentId === id || isAncestorOf(state, id, newParentId)) return state;
      return {
        ...state,
        // The subtree follows the node without being rewritten: children point
        // to the node, not to the grandparent.
        nodes: state.nodes.set(id, { ...cur, parentId: newParentId, orderKey }),
      };
    }
    // --- pages --------------------------------------------------------------
    // Pages are the ROOT containers (a parentId can be the id of a node
    // or that of a Page): an op that touches them changes where nodes can
    // live, not a node. Parity with core.applyCreatePage / applyDeletePage /
    // applyRenamePage (Go).
    case "createPage": {
      const page = op.kind.value.page;
      // Page absent or without id = ErrNilPage; id ALREADY TAKEN -- by another
      // page or by a NODE -- = ErrPageExists. The collision with a node counts
      // as much as that with a page: parentExists answers "yes" for both,
      // so two homonymous containers would make the parent of whoever
      // names them ambiguous.
      if (!page || page.id === "" || parentExists(state, page.id)) return state;
      // At the END, like Go: the position in the list is the order of the page
      // selector, not a property of the document.
      const created = pageOf(page);
      if (!masterFieldsValid(state.pages, created)) return state; // ErrBadMaster
      if (!isValidPageSetup(created)) return state;               // ErrBadPageSetup
      return { ...state, pages: [...state.pages, created] };
    }
    // Moves a page to `index` of the page order. Parity with core.applyMovePage.
    case "movePage": {
      const { id, index } = op.kind.value;
      const i = state.pages.findIndex((p) => p.id === id);
      if (i < 0 || index >= state.pages.length) return state;
      const rest = state.pages.filter((p) => p.id !== id);
      return { ...state, pages: [...rest.slice(0, index), state.pages[i], ...rest.slice(index)] };
    }
    // Absolute upsert of the document settings (vertical, baseline grid). Parity with core.applySetDocSettings.
    case "setDocSettings": {
      const s = op.kind.value.settings;
      if (!s || !isValidDocSettings(s)) return state;
      const settings = toDocSettings(s);
      const { settings: _drop, ...rest } = state;
      void _drop;
      return Object.keys(settings).length > 0 ? { ...rest, settings } : rest;
    }
    // Absolute upsert of a page's name / master flag / applied master / sheet setup. Parity with core.applyUpdatePage.
    case "updatePage": {
      const page = op.kind.value.page;
      if (!page || page.id === "") return state;
      const next = pageOf(page);
      if (!updatePageAllowed(state.pages, next)) return state;
      return { ...state, pages: state.pages.map((p) => (p.id === next.id ? next : p)) };
    }
    // Deletes the page AND ALL the nodes hanging under it. Same cascade as
    // deleteNode brought to the root: what is not reachable from any
    // page is not part of the document, so leaving its nodes in the map
    // would be the orphans that createNode refuses to create.
    case "deletePage": {
      const { id } = op.kind.value;
      const i = state.pages.findIndex((p) => p.id === id);
      if (i < 0) return state;                    // ErrPageNotFound
      // The LAST regular page is not deleted (without pages no valid parent exists), and a master
      // that pages still apply is not deleted either: ErrLastPage / ErrMasterInUse.
      if (!deletePageAllowed(state.pages, id)) return state;
      const nodes = state.nodes.edit();
      const gone = new Set<string>();
      for (const root of childrenOf(state, id)) {
        for (const n of subtreeOf(state, root.id)) { nodes.delete(n.id); gone.add(n.id); }
      }
      return {
        ...state, pages: [...state.pages.slice(0, i), ...state.pages.slice(i + 1)], nodes: nodes.done(),
        ...cascadeFlows(state, gone), ...cascadeClips(state, gone), ...cascadeComponentTargets(state, gone),
      };
    }
    case "renamePage": {
      const { id, name } = op.kind.value;
      const i = state.pages.findIndex((p) => p.id === id);
      if (i < 0) return state;                    // ErrPageNotFound
      const pages = [...state.pages];
      // Written ALWAYS, even empty: the incoming value is the final value, and
      // the fallback for an empty name belongs to the UI (as for Node.name).
      pages[i] = { ...pages[i], name };
      return { ...state, pages };
    }
    // --- components / instances (M4) ----------------------------------------
    // Parity with core.applyCreateComponent / applySetInstanceOverride (Go).
    case "createComponent": {
      const { componentId, rootNodeId, name } = op.kind.value;
      // empty id (Go replies ErrComponentNotFound "(empty id)"), id ALREADY TAKEN
      // (ErrComponentExists) or root not in `nodes` (ErrNodeNotFound): in all
      // three cases the server rejects the op and registers nothing, so here the
      // scene stays unchanged (same object, so selectors do not wake up
      // for nothing).
      if (componentId === "" || state.components[componentId] || !state.nodes.at(rootNodeId)) return state;
      // It does not copy the subtree: it references it. The master stays alive in `nodes`,
      // and master->instances propagation is therefore free.
      return { ...state, components: { ...state.components, [componentId]: { rootNodeId, name } } };
    }
    // --- flows --------------------------------------------------------------
    // Parity with core.applySetFlow / applyDeleteFlow / applySetTransition /
    // applyDeleteTransition (Go, internal/core/flows.go). ABSOLUTE upserts.
    case "setFlow": {
      const f = op.kind.value.flow;
      if (!f || f.id === "") return state;                                  // ErrNilFlow
      if (f.startId !== "" && !state.nodes.has(f.startId)) return state;    // ErrNodeNotFound
      return { ...state, flows: { ...state.flows, [f.id]: toFlowLite(f) } };
    }
    case "deleteFlow": {
      const { id } = op.kind.value;
      if (!state.flows[id]) return state;                                   // ErrFlowNotFound
      const flows = { ...state.flows };
      delete flows[id];
      const transitions: Record<string, TransitionLite> = {};
      for (const [tid, t] of Object.entries(state.transitions)) if (t.flowId !== id) transitions[tid] = t;
      return { ...state, flows, transitions };
    }
    case "setTransition": {
      const t = op.kind.value.transition;
      if (!t || t.id === "") return state;                                  // ErrNilTransition
      if (!state.flows[t.flowId]) return state;                             // ErrFlowNotFound
      if (!state.nodes.has(t.fromId) || !state.nodes.has(t.toId)) return state; // ErrNodeNotFound
      if (t.elementId !== "" && !state.nodes.has(t.elementId)) return state;
      // ErrTransitionAnim: a closed animation set and sane timing (parity with core.applySetTransition).
      if (t.animation !== "" && !(TRANSITION_ANIMATIONS as readonly string[]).includes(t.animation)) return state;
      if (t.durationMs < 0 || t.durationMs > 10000 || t.delayMs < 0 || t.delayMs > 60000 || !isValidEasing(t.easing)) return state;
      if (t.order < 0 || t.order > MAX_TRANSITION_ORDER) return state;      // ErrTransitionOrder
      return { ...state, transitions: { ...state.transitions, [t.id]: toTransitionLite(t) } };
    }
    case "deleteTransition": {
      const { id } = op.kind.value;
      if (!state.transitions[id]) return state;                             // ErrTransitionNotFound
      const transitions = { ...state.transitions };
      delete transitions[id];
      return { ...state, transitions };
    }
    // --- animation ----------------------------------------------------------
    // Parity with core.applySetClip / applyDeleteClip (Go, internal/core/animation.go).
    // ABSOLUTE upsert of the whole clip; validation is isValidClip (same
    // logic as core.validateClip: an invalid op leaves the scene unchanged).
    case "setClip": {
      const c = op.kind.value.clip;
      if (!c || c.id === "") return state;                                  // ErrNilClip
      const lite = toClipLite(c);
      if (!isValidClip(state, lite)) return state;
      return { ...state, clips: { ...state.clips, [c.id]: lite } };
    }
    case "deleteClip": {
      const { id } = op.kind.value;
      if (!state.clips[id]) return state;                                   // ErrClipNotFound
      const clips = { ...state.clips };
      delete clips[id];
      return { ...state, clips };
    }
    // --- variables ----------------------------------------------------------
    // Parity with core.applySetCollection / applyDeleteCollection /
    // applySetVariable / applyDeleteVariable (Go, internal/core/variables.go).
    // ABSOLUTE upserts; the validation is variables.ts (the same rules).
    case "setCollection": {
      const c = op.kind.value.collection;
      if (!isValidCollection(c)) return state;
      const lite = toCollectionLite(c);
      const next = { ...state, collections: { ...state.collections, [c.id]: lite } };
      return state.collections[c.id] ? { ...next, ...dropRemovedModes(next, lite) } : next;
    }
    case "deleteCollection": {
      const { id } = op.kind.value;
      if (!state.collections[id]) return state;                             // ErrCollectionNotFound
      const collections = { ...state.collections };
      delete collections[id];
      // Its variables go with it (and the aliases of them), and so do the bindings to them and the pins.
      const variables: SceneState["variables"] = {};
      const own = new Set<string>();
      for (const v of Object.values(state.variables)) if (v.collectionId === id) own.add(v.id);
      const gone = withAliases(state, own);
      for (const [vid, v] of Object.entries(state.variables)) if (!gone.has(vid)) variables[vid] = v;
      return { ...state, collections, variables, nodes: unbindNodes(state, gone, id) };
    }
    case "setVariable": {
      const v = op.kind.value.variable;
      if (!isValidVariable(state, v)) return state;
      return { ...state, variables: { ...state.variables, [v.id]: toVariableLite(v) } };
    }
    case "deleteVariable": {
      const { id } = op.kind.value;
      if (!state.variables[id]) return state;                               // ErrVariableNotFound
      const gone = withAliases(state, new Set([id]));                       // its aliases go with it
      const variables = { ...state.variables };
      for (const g of gone) delete variables[g];
      // A tint of a swatch that went stays a swatch of the color it shows, no longer a tint.
      for (const v of Object.values(variables)) {
        if (v.tintOf !== undefined && gone.has(v.tintOf)) { const { tintOf: _t, tint: _n, ...rest } = v; void _t; void _n; variables[v.id] = rest; }
      }
      return { ...state, variables, nodes: unbindNodes(state, gone) };
    }
    // --- component variants and properties ---------------------------------
    // Parity with core.applySetComponentSet / applyDeleteComponentSet /
    // applySetComponentDef / applySetInstanceProps (Go, internal/core/components.go).
    case "setComponentSet": {
      const { componentSet: set, axisRenames, optionRenames } = op.kind.value;
      if (!isValidComponentSet(set)) return state;
      // The renames carry the members' and the instances' choices over to the new names
      // BEFORE the members that no longer fit are detached (ErrSetRenames when invalid).
      const rn = makeRenamer(set, axisRenames, optionRenames);
      if (!rn) return state;
      const carried = rn.empty ? null : carryRenames(state, set, rn);
      if (!rn.empty && !carried) return state;
      const base = carried ? { ...state, components: carried.components, nodes: carried.nodes } : state;
      const next = { ...base, componentSets: { ...base.componentSets, [set.id]: toComponentSetLite(set) } };
      return { ...next, components: detachInvalidMembers(next, set.id) };
    }
    case "deleteComponentSet": {
      const { id } = op.kind.value;
      if (!state.componentSets[id]) return state;                           // ErrComponentSetNotFound
      const componentSets = { ...state.componentSets };
      delete componentSets[id];
      return { ...state, componentSets, components: detachInvalidMembers({ ...state, componentSets }, id) };
    }
    case "setComponentDef": {
      const d = op.kind.value;
      if (!isValidComponentDef(state, d)) return state;
      const cur = state.components[d.componentId];
      const next = { rootNodeId: cur.rootNodeId, name: cur.name } as typeof cur;
      if (d.setId !== "") next.setId = d.setId;
      if (Object.keys(d.variant).length > 0) next.variant = { ...d.variant };
      if (d.properties.length > 0) next.properties = d.properties.map(toComponentPropertyLite);
      return { ...state, components: { ...state.components, [d.componentId]: next } };
    }
    case "setInstanceProps": {
      const { instanceId, propertyValues, variantProps } = op.kind.value;
      const cur = state.nodes.at(instanceId);
      if (!cur) return state;                                               // ErrNodeNotFound
      if (cur.kind !== "instance" || !cur.instance) return state;           // ErrNotInstanceNode
      if (!isValidInstanceProps(state, cur.instance, propertyValues, variantProps)) return state;
      const { propertyValues: _pv, variantProps: _vp, ...rest } = cur.instance;
      const instance = {
        ...rest,
        ...(Object.keys(propertyValues).length > 0 ? { propertyValues: { ...propertyValues } } : {}),
        ...(Object.keys(variantProps).length > 0 ? { variantProps: { ...variantProps } } : {}),
      };
      return { ...state, nodes: state.nodes.set(instanceId, { ...cur, instance }) };
    }
    // --- typography ---------------------------------------------------------
    // Parity with core.applySetFont / applyDeleteFont / applySetTextStyleDef /
    // applyDeleteTextStyleDef (Go, internal/core/typography.go). ABSOLUTE upserts.
    // Comments (parity with core.applySetComment / applyDeleteComment, internal/core/comments.go).
    case "setComment": {
      const c = op.kind.value.comment;
      if (!isValidComment(state, c)) return state;
      return { ...state, comments: { ...state.comments, [c.id]: toCommentLite(c) } };
    }
    case "deleteComment": {
      const { id } = op.kind.value;
      if (!state.comments[id]) return state;                                // ErrCommentNotFound
      return { ...state, comments: withoutComment(state, id) };
    }
    // Dev mode (parity with core.applySetAnnotation ... applyClearReadyForDev, internal/core/devmode.go).
    // The ready entry's snapshot is the server's business: here only the mark is kept.
    case "setAnnotation": {
      const a = op.kind.value.annotation;
      if (!isValidAnnotation(state, a)) return state;
      const dev = state.dev ?? { annotations: {}, ready: {} };
      return { ...state, dev: { ...dev, annotations: { ...dev.annotations, [a.id]: toAnnotationLite(a) } } };
    }
    case "deleteAnnotation": {
      const { id } = op.kind.value;
      if (!annotationsOfScene(state)[id]) return state;                     // ErrAnnotationNotFound
      const annotations = { ...annotationsOfScene(state) };
      delete annotations[id];
      return { ...state, dev: { annotations, ready: readyOfScene(state) } };
    }
    case "setReadyForDev": {
      const r = op.kind.value.ready;
      if (!isValidReady(state, r)) return state;
      const dev = state.dev ?? { annotations: {}, ready: {} };
      return { ...state, dev: { ...dev, ready: { ...dev.ready, [r.nodeId]: toReadyLite(r) } } };
    }
    case "clearReadyForDev": {
      const { nodeId } = op.kind.value;
      if (!readyOfScene(state)[nodeId]) return state;                       // ErrReadyNotFound
      const ready = { ...readyOfScene(state) };
      delete ready[nodeId];
      return { ...state, dev: { annotations: annotationsOfScene(state), ready } };
    }
    case "setFont": {
      const f = op.kind.value.font;
      if (!isValidFont(state, f)) return state;
      return { ...state, fonts: { ...state.fonts, [f.id]: toFontLite(f) } };
    }
    case "deleteFont": {
      const { id } = op.kind.value;
      if (!state.fonts[id]) return state;                                   // ErrFontNotFound
      const fonts = { ...state.fonts };
      delete fonts[id];
      return { ...state, fonts };
    }
    case "setTextStyleDef": {
      const d = op.kind.value.textStyle;
      if (!isValidTextStyleDef(state, d)) return state;
      return { ...state, textStyles: { ...state.textStyles, [d.id]: toTextStyleDefLite(d) } };
    }
    // Parity with core.applySetObjectStyleDef / applyDeleteObjectStyleDef / applySetLayer / applyDeleteLayer.
    case "setObjectStyleDef": {
      const d = op.kind.value.objectStyle;
      if (!isValidObjectStyle(state, d)) return state;
      return { ...state, objectStyles: { ...state.objectStyles, [d.id]: toObjectStyleLite(d) } };
    }
    case "deleteObjectStyleDef": {
      const { id } = op.kind.value;
      if (!state.objectStyles[id]) return state;                            // ErrObjectStyleMissing
      const objectStyles: SceneState["objectStyles"] = {};
      for (const [k, d] of Object.entries(state.objectStyles)) {
        if (k === id) continue;
        if (d.basedOn === id) { const { basedOn: _b, ...rest } = d; void _b; objectStyles[k] = rest; } else objectStyles[k] = d;
      }
      return { ...state, objectStyles, nodes: detachNodes(state, "objectStyleId", id) };
    }
    case "setLayer": {
      const l = op.kind.value.layer;
      if (!isValidLayer(state, l)) return state;
      const next = toLayerLite(l);
      const at = state.layers.findIndex((x) => x.id === l.id);
      const layers = at >= 0 ? state.layers.map((x, i) => (i === at ? next : x)) : [...state.layers, next];
      const pos = op.kind.value.position;
      if (pos > 0) {
        // Moved to that (1-based) place; beyond the end means last.
        const from = layers.findIndex((x) => x.id === l.id);
        const rest = layers.filter((_, i) => i !== from);
        const to = Math.min(pos - 1, rest.length);
        return { ...state, layers: [...rest.slice(0, to), next, ...rest.slice(to)] };
      }
      return { ...state, layers };
    }
    case "deleteLayer": {
      const { id } = op.kind.value;
      if (!state.layers.some((l) => l.id === id)) return state;             // ErrLayerMissing
      return { ...state, layers: state.layers.filter((l) => l.id !== id), nodes: detachNodes(state, "layerId", id) };
    }
    case "deleteTextStyleDef": {
      const { id } = op.kind.value;
      if (!state.textStyles[id]) return state;                              // ErrTextStyleMissing
      const textStyles = { ...state.textStyles };
      delete textStyles[id];
      return { ...state, textStyles, nodes: unstyleNodes(state, id) };
    }
    // Shared paint / effect styles (parity with core.applySetPaintStyleDef & co, internal/core/styles.go).
    case "setPaintStyleDef": {
      const d = op.kind.value.paintStyle;
      if (!isValidPaintStyleDef(d)) return state;
      return { ...state, paintStyles: { ...state.paintStyles, [d.id]: toPaintStyleDefLite(d) } };
    }
    case "deletePaintStyleDef": {
      const { id } = op.kind.value;
      if (!state.paintStyles[id]) return state;                             // ErrPaintStyleMissing
      const paintStyles = { ...state.paintStyles };
      delete paintStyles[id];
      return { ...state, paintStyles, nodes: unstyleNodesByPaint(state, id, "paint") };
    }
    case "setEffectStyleDef": {
      const d = op.kind.value.effectStyle;
      if (!isValidEffectStyleDef(d)) return state;
      return { ...state, effectStyles: { ...state.effectStyles, [d.id]: toEffectStyleDefLite(d) } };
    }
    case "deleteEffectStyleDef": {
      const { id } = op.kind.value;
      if (!state.effectStyles[id]) return state;                            // ErrEffectStyleMissing
      const effectStyles = { ...state.effectStyles };
      delete effectStyles[id];
      return { ...state, effectStyles, nodes: unstyleNodesByPaint(state, id, "effect") };
    }
    // Replaces an instance's payload wholesale (swap, reset). Parity with core.applySetInstance.
    case "setInstance": {
      const { instanceId, instance } = op.kind.value;
      const cur = state.nodes.at(instanceId);
      if (!cur) return state;                                               // ErrNodeNotFound
      if (cur.kind !== "instance" || !cur.instance) return state;           // ErrNotInstanceNode
      if (!isValidInstanceBody(state, instanceId, instance)) return state;
      return { ...state, nodes: state.nodes.set(instanceId, { ...cur, instance: toInstanceLite(instance) }) };
    }
    case "setInstanceOverride": {
      const { instanceId, override } = op.kind.value;
      const cur = state.nodes.at(instanceId);
      // Nonexistent node = ErrNodeNotFound; NON-instance node = ErrNotInstanceNode
      // (an override on a rectangle is an op on the wrong node, not a field to
      // fill); empty master_node_id = rejected in Go. In all cases scene
      // unchanged.
      if (!cur) return state;
      if (cur.kind !== "instance" || !cur.instance) return state;
      if (!override || override.masterNodeId === "") return state;
      // Upsert by master_node_id, EXACTLY like core.applySetInstanceOverride:
      // remove the override with the same master, then put the new one back ONLY if it
      // really overrides something (fills_present || text_present). Otherwise
      // the op IS a removal -- the master's node goes back to inheriting from the master.
      const kept = cur.instance.overrides.filter((o) => o.masterNodeId !== override.masterNodeId);
      if (override.fillsPresent || override.textPresent) kept.push(toInstanceOverrideLite(override));
      return {
        ...state,
        nodes: state.nodes.set(instanceId, { ...cur, instance: { ...cur.instance, overrides: kept } }),
      };
    }
    default:
      return state;
  }
}

// Removes from clips what animated the just-deleted nodes (parity with
// core.cascadeClips in Go): tracks on vanished nodes are removed and clips whose
// TARGET vanished are deleted. A clip left without tracks but with a live
// target is kept. The touched entries are replaced, never mutated.
export function cascadeClips(
  state: SceneState, gone: ReadonlySet<string>,
): Partial<Pick<SceneState, "clips">> {
  let changed = false;
  const clips: Record<string, ClipLite> = {};
  for (const [id, c] of Object.entries(state.clips)) {
    if (gone.has(c.targetId)) { changed = true; continue; }
    if (c.tracks.some((t) => gone.has(t.nodeId))) {
      changed = true;
      clips[id] = { ...c, tracks: c.tracks.filter((t) => !gone.has(t.nodeId)) };
      continue;
    }
    clips[id] = c;
  }
  return changed ? { clips } : {};
}

// Removes from flows what referenced the just-deleted nodes (parity with
// core.cascadeFlows in Go): transitions that cross them disappear, the
// `startId` of flows that started from them is emptied and the `elementId` of
// transitions that used them as hotspot is reset. Returns only the changed
// fields, so a scene without flows keeps the same objects.
export function cascadeFlows(
  state: SceneState, gone: ReadonlySet<string>,
): Partial<Pick<SceneState, "flows" | "transitions">> {
  const out: Partial<Pick<SceneState, "flows" | "transitions">> = {};
  let tChanged = false;
  const transitions: Record<string, TransitionLite> = {};
  for (const [id, t] of Object.entries(state.transitions)) {
    if (gone.has(t.fromId) || gone.has(t.toId)) { tChanged = true; continue; }
    if (t.elementId !== "" && gone.has(t.elementId)) { tChanged = true; transitions[id] = { ...t, elementId: "" }; continue; }
    transitions[id] = t;
  }
  if (tChanged) out.transitions = transitions;
  let fChanged = false;
  const flows = { ...state.flows };
  for (const [id, f] of Object.entries(state.flows)) {
    if (f.startId !== "" && gone.has(f.startId)) { fChanged = true; flows[id] = { ...f, startId: "" }; }
  }
  if (fChanged) out.flows = flows;
  return out;
}
