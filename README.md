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

1. Pick a picture from the gallery. Its unfinished mosaic shows muted, numbered spots.
2. Tap any jewel. Every jewel of that color pops up, in the jewel pile and in the tray at the bottom,
   and the picture's empty spots for that color start to glow.
3. Tap a glowing spot. All the popped jewels fly into that color's empty spots, filling outward from where you tapped.
   Or tap the tray at the bottom to park the popped jewels in its 7 spaces and gather more of that color first.
4. Tap the popped jewel again to put the color back down. You can also drag a jewel onto the picture or the tray.
5. New jewels are dealt as the pile empties, from at most six colors at a time. When a color is finished, the next one joins.
6. Fill the last spots, enjoy the reveal, and the next picture in the album unlocks.

Hint, Rearrange, and Undo are free and unlimited. Hint flashes a jewel and a spot for it.
Undo returns the most recent jewels you parked in the tray to the pile. Jewels placed in the picture stay there.
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
| `js/engine.js` | Pure rules: jewel pile, holding tray, placing a color from a tapped spot, undo, hint, rearrange, invariants. No DOM. |
| `js/validate.js` | Level validator plus an automated playthrough that checks inventory at every step. |
| `js/pictures.js` | Picture library: grids of palette keys (`.` = intentionally empty cell). |
| `js/storage.js` | Versioned save with atomic write and one backup copy. |
| `js/mosaic.js` | Canvas renderer for the mosaic with pinch, pan, and zoom. |
| `js/jewels.js` | Faceted jewel sprite drawing, shared by every color. |
| `js/audio.js` | Synthesized sound effects (Web Audio). |
| `js/main.js` | Screens, input, animation, tutorial, gallery, settings. |

The game saves after every placement and tray move, and whenever the page is hidden.
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
- placing a color uses every popped jewel, from the pile and the tray, and fills outward from the tapped spot
- a spot of the wrong color is rejected without changing anything
- the tray takes only what fits and refuses more when full; undo returns tray moves to the pile
- a finished color introduces the next one, and only colors in play are dealt
- an exact save and restore resumes play identically; corrupted saves are rejected and fall back to the backup
- all 20 pictures play to completion from many random seeds, mixing placements, tray moves, and undos
