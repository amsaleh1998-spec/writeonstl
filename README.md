# WriteOnSTL

A browser app for adding **embossed (raised)** or **engraved (cut-in)** text to STL files for 3D printing.
Everything runs locally in the browser, so your files are never uploaded anywhere.

## Features

- **Load any STL** (binary or ASCII) with the file picker or by dragging it onto the page. There are also sample models (plate, cylinder, sphere, coin) to try things out.
- **Click the model to place text**, then drag the text to move it around. The text reads upright from your current view.
  **Ctrl**+drag the text (⌘ on a Mac also works) rotates it, with the grabbed point following the mouse around the text's centre. Scrolling the **mouse wheel over the text** changes the letter height.
- **3D view controls**, the same as the 3D view in Quick DICOM Planning:
  - left-drag rotates freely, including over the top. A quick flick keeps the model turning and slows it down like a scroll.
  - right-drag zooms around the pressed point, and the wheel zooms at the cursor (Ctrl+wheel or a trackpad pinch also zooms over the text).
  - middle-drag, or Shift/Alt + left-drag, pans.
  - **middle-click** on the model makes that point the centre of rotation without moving the view. A marker shows the centre while you rotate.
  - **double-click the background**, or ⟲ in the toolbar, resets the view. The toolbar also has the standard views.
- **3Dconnexion SpaceMouse** (⚙ in the view toolbar). Click *Connect SpaceMouse* once in Chrome or Edge (it uses WebHID and works with wired, wireless and Universal Receiver models). After that it reconnects automatically. It works in object mode, where the model follows the cap:
  - tilt or twist rotates, push sideways pans, and pull up / push down zooms.
  - the left button resets the view, and the right button steps through front, right, back, left, top and bottom.
  - there's a speed slider and invert options.
  - wheel events that the 3Dconnexion driver generates are ignored while the cap moves.
- **Emboss or engrave**, with controls for:
  - letter height (in mm, measured on capital letters)
  - raised height / engrave depth (thickness)
  - boldness (grows or shrinks the letter outlines)
  - letter spacing, line spacing, multi-line alignment
  - rotation and mirroring
- **Follow curved surfaces**: on cylinders, spheres and other curved parts, the text bends to stay a constant height above (or depth below) the surface. With this turned off you get flat-topped text that is still sunk deep enough to fuse with the model everywhere.
- **12 bundled fonts**, and you can upload your own `.ttf`, `.otf` or `.woff` font.
- **Exact, watertight booleans** using [Manifold](https://github.com/elalish/manifold). If an STL isn't watertight, the app falls back to approximate CSG ([three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg)) and warns you.
- Apply several texts one after another, with **Undo** (Ctrl/⌘+Z) and **Reset**, then **Download STL**.
  The downloaded file is named after the model and the texts you added, e.g. `plate-Hello-Lot_7.stl`. Spaces and line breaks become `_`, and characters that file names can't contain are removed.

## Aligner cases (numbering every stage)

For clear-aligner production, you can label a whole case in one go. The app reads the export of an aligner program, such as 3Shape Clear Aligner Studio:

```
<case>_Subsetup1/Maxillary.stl
<case>_Subsetup1/Maxillary_with_attachments.stl   ← attachment template (stage 1)
<case>_Subsetup1/Mandibular.stl
<case>_Subsetup1/Mandibular_with_attachments.stl
<case>_Subsetup2/Maxillary.stl
…
ClearAlignerProductionResources.xml
```

1. **Open the case.** Click **Open aligner export folder…** and pick the export folder (or a folder above it), or drop the folder onto the page. ZIPs of the export also work, even split into several parts: use *Open STL…* or drop them. A subsetup folder may hold only one jaw.
2. **Place the number on stage 1.** In the **Aligner case** panel, pick *Maxillary* or *Mandibular* and *Number*, then click the model where the number should go. The label text is a template, where `{n}` becomes the subsetup number, so `U{n}` gives `U1`, `U2` and so on. All the models share one coordinate system, so the number lands on the same spot of every stage. Step through the stages (‹ ›) to check each one.
3. **Place the T.** Choose *T on attachments* and click where the T should go on the stage 1 model with attachments. The number appears there in purple so the two labels don't overlap. *Also number the attachment models* (on by default) gives that model its number as well.
4. **Label everything.** Repeat for the other jaw, then click **Label all models & download ZIP**. Every model is labelled with the current style (font, size, emboss or engrave, depth, and so on). The ZIP keeps the export's folder and file names, and the original XML, so it can go straight to production.

The panel shows what is still missing. A warning appears when a label crosses an edge (for example the rim of a hollowed base) or hangs off the model. After processing, a note lists any models where that happened.

Units are assumed to be millimetres, which is the convention for 3D-printing STLs.

## Development

```bash
npm install
npm run dev       # start the dev server
npm test          # Node smoke test of the geometry pipeline
npm run build     # production build in dist/
npm run preview   # serve the production build
```

### Deploying

`.github/workflows/deploy.yml` builds the site and publishes it to GitHub Pages whenever `main` is pushed.
To turn it on, go to **Settings → Pages** and set the source to **GitHub Actions**.
The build uses relative paths, so `dist/` can also be hosted on any static host.

## How it works

1. `src/text.js` uses [opentype.js](https://github.com/opentypejs/opentype.js) to lay out the text (with kerning) and flattens the glyph curves into polygons.
2. `src/geom.js` turns the polygons into a Manifold `CrossSection` (the NonZero fill rule merges overlapping script glyphs), applies the boldness offset, and extrudes it. In *follow surface* mode, the solid is refined and each vertex is warped along the surface normal using BVH-accelerated raycasts against the model.
3. The text solid is unioned with the model (emboss) or subtracted from it (engrave), and the result is written out as a binary STL.

## Project layout

```
index.html            UI markup
src/main.js           three.js viewer, interaction, UI wiring
src/viewControls.js   camera control (free rotate, flick, zoom, pan, rotation centre)
src/spacemouse.js     3Dconnexion SpaceMouse input (WebHID / game controller)
src/aligner.js        recognising aligner exports (stages, jaws, attachment models)
src/text.js           font → 2D outlines
src/geom.js           solid modelling (Manifold), STL writer
src/style.css         styles (light/dark)
public/fonts/         bundled fonts + licenses
scripts/smoke-test.mjs
```
