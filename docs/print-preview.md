# Print preview: separations, overprint, trapping

`web/src/tools/printPreview.ts` (pure functions over the scene) and the Ink manager dialog (Document menu).

- Separations: `platesOf` lists the plates in use (Cyan, Magenta, Yellow, Black, then each spot ink), `separationView(scene, plate)` gives, per painted object, how much of that plate it carries as a grey (1 = paper). A spot is its own plate, never process ink. The dialog lists each plate with its object count.
- Overprint: `overprintResult` / `overprintPreviewColor` merge the plates of a top ink and the ink under it the way the PDF's overprint mode 1 does (a plate the top ink does not use does not knock out). The decision follows the object's `overprint` setting (fill | stroke | both).
- Trapping: `trapSuggestions` finds touching sibling shapes that share no plate and do not overprint, and says which ink should spread into the other (the lighter into the darker; near-equal densities get a centered trap). The dialog reports the count and the first pairs. Advice only: nothing is changed in the document.

## Honest scope

The model is textbook (no ICC profile, no dot gain, inks multiply). Judged on node boxes, so rotated and rounded shapes are approximate.

## Not done

- Drawing a plate or the overprint preview on the canvas (a view toggle in the renderer): the functions exist, the canvas does not call them yet.
- Creating the trap (a spread stroke with overprint) from a suggestion.
