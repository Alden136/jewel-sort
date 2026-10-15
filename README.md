# Jewel Mosaic

A relaxing mobile game where you sort loose jewels by color and watch them build a picture.
It is built from the *Jewel Picture Sorting Game Plan*: no timer, lives, move limits, ads, or purchases.

## Play

The game is a static web app with no build step. Serve the folder over HTTP and open it on a phone or desktop browser:

```sh
npm start            # serves on http://localhost:8080
# or: python3 -m http.server 8080
```

On a phone, use your browser's "Add to Home Screen" to install it. A service worker caches the game, so it then plays offline.

## How it plays

1. Pick a picture from the gallery. Its unfinished mosaic shows muted, numbered sockets.
2. Tap a color tray to select it, then tap matching jewels in the supply. You can also drag a jewel onto a tray.
3. A tray holds up to eight jewels. When it's full, the jewels fly into the matching cells of the picture.
   A color's last batch is smaller, sized to exactly the cells it still needs.
4. Up to six trays are active at once. When a color finishes, the next one joins the palette.
5. Finish the last cells, enjoy the reveal, and the next picture in the album unlocks.

Hint, Rearrange, and Undo are free and unlimited. Undo returns the most recent jewel whose tray hasn't been sent yet.

## Content

There are 20 original pixel-mosaic pictures in four albums: Night Sky, Flowers and Plants, Animals, and Everyday Objects.
They range from the 81-cell, 3-color tutorial star up to 256-cell pictures with 7–9 colors.
The tutorial and the first picture of each album are open from the start. Each later picture unlocks when you finish the one before it.
Completed pictures stay in the gallery for full-screen viewing, replay, and PNG export.

## Accessibility and settings

Every color carries a number on its jewels, tray, and sockets, so you never have to rely on hue alone.
The settings cover sound and volume, vibration, reduced motion (on by default when the OS asks for it), larger jewels, larger text, hiding the picture preview, and turning off drag-to-sort.
Pinch with two fingers, or use the mouse wheel, to zoom the picture. Double-tap it to fit.

## Code layout

| File | Purpose |
| --- | --- |
| `js/engine.js` | Pure rules: supply, trays, batches, placement order, undo, hint, rearrange, invariants. No DOM. |
| `js/validate.js` | Level validator plus an automated playthrough that checks inventory at every step. |
| `js/pictures.js` | Picture library: grids of palette keys (`.` = intentionally empty cell). |
| `js/storage.js` | Versioned save with atomic write and one backup copy. |
| `js/mosaic.js` | Canvas renderer for the mosaic with pinch, pan, and zoom. |
| `js/jewels.js` | Faceted jewel sprite drawing, shared by every color. |
| `js/audio.js` | Synthesized sound effects (Web Audio). |
| `js/main.js` | Screens, input, animation, tutorial, gallery, settings. |

The game saves after every accepted sort, after every batch commit, and whenever the page is hidden.
Each batch's placement is committed before its animation starts. If the app closes mid-flight, reopening shows the committed result without duplicating any jewels.

### Adding a picture

Add an entry to `js/pictures.js` with a unique `id`, a `title`, an `album`, a `palette` of `{ key, name, color }`, and `rows`.
Palette order is the order the colors are introduced. Then run `npm test`: the validator checks widths, palette references, unused colors, and duplicate names or colors, and plays the level to completion.
If you change a published picture, bump its `version` so old saves for it are discarded instead of misread.

## Tests

```sh
npm test
```

Node's built-in test runner covers the core checks from the plan:
- a final batch smaller than eight leaves no extra jewels
- a finished color introduces the next one, and the supply holds only active colors
- rapid repeat taps are accepted at most once
- an exact save and restore resumes play identically
- corrupted saves are rejected and fall back to the backup
- all 20 pictures play to completion from many random seeds
