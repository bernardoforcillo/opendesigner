# Colour management: ICC profile and gradient swatches

How the editor uses a printer's ICC profile, and how gradients are kept as swatches. The earlier swatch, CMYK
and ink work is in [graphics-colour.md](graphics-colour.md).

## The output profile

`DocSettings.icc_profile_asset` is the hash of an ICC profile file in the document's asset store.
`DocSettings.icc_profile` stays the human-readable name (FOGRA39 ...), shown in the output intent.

- **Storing.** The profile is uploaded through the ordinary asset route, wrapped as `ODICC\n` + the bytes, because the
  server's closed allowlist recognises files by their first bytes and a profile's own signature (`acsp`) sits at byte 36.
  The server accepts only the wrapped form and serves it as `application/x-opendesigner-icc` with `nosniff`. The
  core checks that the field is empty or a 64-digit lowercase hash.
- **Loading.** Swatches dialog > Load ICC profile. The file must be an ICC profile (header signature) and at most 4 MB.
  If the output condition name is empty it takes the profile's own description.
- **Reading** (`web/src/color/icc.ts`). For a CMYK output profile with `mft1` / `mft2` tables, a Lab connection space and
  both `A2B0` and `B2A0`, the reader gives `rgbToCmyk` and `cmykToRgb` (input curves, 4-D and 3-D multilinear CLUT
  interpolation, output curves; RGB is sRGB, via Lab D50). Anything else parses to `null`.
- **Where it applies.**
  - The colour fields (`CmykField`), the Swatches dialog and swatch creation: a CMYK swatch's screen colour comes from
    the profile (`color/activeProfile.ts`, loaded once per document and hash, plain until loaded).
  - The PDF: RGB paints, gradient stops and placeholders of a CMYK document (or PDF/X-1a) are converted through the
    profile. CMYK values a person typed, and spot inks, are never converted.
  - The PDF output intent embeds the profile as `DestOutputProfile` (`/N` 3 or 4, whichever the profile is). A
    profile that is embeddable but not convertible (an RGB profile, or tables this reader does not read) is still
    embedded and the conversion stays the plain device one; the dialog says so.
- **Preflight / package for print** report whether a profile is applied or only a name recorded.

## Gradient swatches

A gradient swatch is a shared **paint style** (`PaintStyleDef`, see [shapes.md](shapes.md)) whose paint is a gradient.
So applying, detaching and deleting reuse the paint-style machinery, and editing the style changes everything that
uses it. In the Swatches dialog you can make one from two colour swatches (a linear gradient), or from the gradient
fill of the selected object; rename it, use it for a fill or a stroke, delete it.
(`web/src/tools/gradientSwatches.ts`.)

## Not done

- Other ICC shapes: v4 `mAB ` tables, XYZ connection spaces, matrix/TRC RGB profiles for conversion, the other intents
  (A2B1/A2B2), black-point compensation, gamut mapping beyond clipping. They embed, but do not convert.
- Soft proofing (previewing the CMYK result on the canvas) and converting images through the profile; images keep
  their own colours in the PDF.
- A profile for PDF/X outside the PDF writer: IDML and the package for print do not embed the profile.
- Gradient stops made from swatches copy the colour at that time; they do not follow later edits of the swatch (a
  gradient stop has no swatch reference in the model). Stops and angle are not editable in the dialog after creation
  (edit the gradient on an object, then make a swatch from it).
- `set_document_settings` (MCP) cannot set the profile file; it is a person's action in the editor.
- A real printer profile was not available to test against: the reader is tested on a synthetic profile built in the
  test with a known answer, so check a proof from the print shop before relying on it.
