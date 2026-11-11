# WriteOnSTL

A browser app for adding **embossed (raised)** or **engraved (cut-in)** text to STL files for 3D printing.
Everything runs locally in the browser, so your files are never uploaded anywhere.

## Features

- **Load any STL** (binary or ASCII) with the file picker or by dragging it onto the page. There are also sample models (plate, cylinder, sphere, coin) to try things out.
- **Click the model to place text**, then drag the text to move it around. The text reads upright from your current view.
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
src/text.js           font → 2D outlines
src/geom.js           solid modelling (Manifold), STL writer
src/style.css         styles (light/dark)
public/fonts/         bundled fonts + licenses
scripts/smoke-test.mjs
```
