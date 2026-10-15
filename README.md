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

1. Pick a picture from the gallery. Every spot is covered by a jewel sitting on a spot of the wrong color.
   Misplaced jewels are drawn small, so the color their spot needs shows around them.
   (When one color covers more than half a picture, a few of its jewels have to start in place.)
2. Tap any misplaced jewel. Every misplaced jewel of that color lifts up, and that color's spots glow.
3. Tap a glowing spot. The lifted jewels move onto that color's spots, filling outward from where you tapped.
   A wrong jewel already sitting on one of those spots is bumped into the 7-space tray at the bottom.
   When the tray is full, only empty spots get filled.
4. Tap a tray jewel to pick up its color, then a spot of that color. Empty spots are filled first, which frees tray space.
   You can also tap the tray to lift a picked-up color off the picture, or drag a tray jewel onto the picture.
5. Finish when every jewel is on its own color. The reveal plays, and the next picture in the album unlocks.

Hint and Undo are free and unlimited. Hint flashes a jewel and a spot for it, and always points to a move that works.
Undo puts the most recent jewels you lifted into the tray back where they were.
Tapping a spot of the wrong color does nothing except give a gentle message.

## Content

There are 20 original pixel-mosaic pictures in four albums: Night Sky, Flowers and Plants, Animals, and Everyday Objects.
They range from the 81-cell, 3-color tutorial star up to 256-cell pictures with 7–9 colors.
The tutorial and the first picture of each album are open from the start. Each later picture unlocks when you finish the one before it.
Completed pictures stay in the gallery for full-screen viewing, replay, and PNG export.

## Accessibility and settings

Every color carries a number on its jewels and on its spots in the picture, so you never have to rely on hue alone.
The settings cover sound and volume, vibration, reduced motion (on by default when the OS asks for it), larger jewels, larger text, hiding the picture preview, and turning off drag-to-sort.
Pinch with two fingers, or use the mouse wheel, to zoom the picture. Double-tap it to fit.

## Code layout

| File | Purpose |
| --- | --- |
| `js/engine.js` | Pure rules: the starting scatter, placing a color from a tapped spot, bumping into the tray, undo, hint, invariants. No DOM. |
| `js/validate.js` | Level validator plus an automated playthrough that checks inventory at every step. |
| `js/pictures.js` | Picture library: grids of palette keys (`.` = intentionally empty cell). |
| `js/storage.js` | Versioned save with atomic write and one backup copy. |
| `js/mosaic.js` | Canvas renderer for the mosaic with pinch, pan, and zoom. |
| `js/jewels.js` | Faceted jewel sprite drawing, shared by every color. |
| `js/audio.js` | Synthesized sound effects (Web Audio). |
| `js/main.js` | Screens, input, animation, tutorial, gallery, settings. |

The game saves after every placement and tray lift, and whenever the page is hidden.
Each placement is committed before its animation starts. If the app closes mid-flight, reopening shows the committed result without duplicating any jewels.

### Adding a picture

Add an entry to `js/pictures.js` with a unique `id`, a `title`, an `album`, a `palette` of `{ key, name, color }`, and `rows`.
Palette order is the order the colors are introduced. Then run `npm test`: the validator checks widths, palette references, unused colors, and duplicate names or colors, and plays the level to completion.
If you change a published picture, bump its `version` so old saves for it are discarded instead of misread.

## Tests

```sh
npm test
```

Node's built-in test runner covers the core checks:
- the starting scatter keeps every jewel, and only the unavoidable minimum starts on its own color
- placing bumps the jewels in the way into the tray, uses tray jewels first, and never overfills the tray
- a spot of the wrong color is rejected without changing anything
- undo returns lifted jewels to their spots, and forgets moves whose spots were filled since
- the hint always names a move that succeeds
- an exact save and restore resumes play identically; corrupted saves are rejected and fall back to the backup
- all 20 pictures play to completion from many random seeds, mixing placements, tray lifts, and undos
