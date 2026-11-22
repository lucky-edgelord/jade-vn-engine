# jade-vn-engine

A visual novel engine for the browser and [webxdc](https://webxdc.org): Ren'Py-style scripts, game logic in
MicroPython (WebAssembly), a canvas renderer, and optional modules that load only when a game uses them.

```
tools/vnc.py      .rpy -> game.json compiler (labels, menus, if/while, call/jump, ATL, screen language)
tools/build.py    package a game folder as a static site + .xdc
engine/vn.js      runtime core: VM, renderer, layout, text tags, audio, saves, rollback, history, skip/auto
engine/prelude.py the Python side: store, Character, actions, displayables, transitions, screens
engine/stdlib.rpy default screens (say, choice, menus, save/load, history, preferences) - override any
engine/fx.js      lazy: WebGL post effects - vhs, crt, static, interference, glitch, rgbshift, badtv, echo,
                  nightvision, thermal, pulse, creep, flicker, melt, halftone, dither, colour grades
                  (Instagram-style and horror presets), 3D LUT strips, and vectoria (the VHS
                  look from aio-marketplace's Vectoria module, ported from its ffmpeg chain)
engine/light.js   lazy: 2D lighting - darkness, flickering coloured lights, ray-cast shadows, dust
engine/tiles.js   lazy: TileMap - top-down grid scroller (smooth steps, 4-way sprites, NPCs, tap-to-walk,
                  wall-shadowed lighting); MapView - map mode / minimap
engine/tour.js    lazy: Tour - faux-3D interiors from 360° or flat snapshots, real-estate-tour style
engine/lib/rpg.rpy        opt-in: party, items, spells, Phantasy Star-style first-person battles
engine/lib/minigames.rpy  opt-in: qte, mash, lockpick timing, keypad, memory, sliding puzzle, simon
engine/analog.js  lazy: generated tape hiss, 60/50 Hz mains hum, CRT flyback whine, motor rumble
engine/vendor/    MicroPython WebAssembly build (MIT, see MICROPYTHON-LICENSE)
```

## Script

```renpy
define e = Character("Eileen", who_color="#c8ffc8")
default points = 0
image bg dusk = Solid("#334")

label start:
    scene bg dusk with fade
    e "Hello! You have [points] points.{w=0.3} {wave}Nice.{/wave}"
    $ renpy.fx("rgbshift", amount=0.006, duration=0.8)
    menu:
        "More points":
            $ points += 10
        "Fewer" if points > 100:
            pass
    return
```

Screens use the screen language (`add`, `text`, `textbutton`, `imagebutton`, `button`, `hbox`/`vbox`/`grid`/`frame`,
`viewport`, `key`, `timer`, `dragbar`, `if`/`for`/`use`, `default`). Lighting is a displayable:

```renpy
screen room():
    viewport:
        child_size (2600, 720) draggable True
        add "room.avif"
        add LightMap([Light(1128, 516, 330, "#ff3a26", flicker=0.35, shadows=True)], dark=0.86,
                     occluders=[(1000, 470, 1640, 600, 18)])
```

## Game modes

Games opt into libraries in `game.toml` (`libs = "rpg, minigames"`); JS modules load the first time a game uses them.

```renpy
screen overworld():
    add TileMap("world", state="pos", tileset=Tileset("tiles.png"), player=CharSheet("people.png"),
                npcs=npcs_here(), light=light_here()) action Function(map_event)   # events in _widget_event
    add MapView("world", state="pos", radius=10) pos (1060, 20) xysize (200, 200)  # minimap

screen house():
    add Tour("house", state="tour_pos") action Function(tour_event)

label fight:
    $ start_battle(["slime", "scorpion"], bg="bg_field.jpg")
    call battle

label safe:
    $ mg_setup("keypad", code="1987")
    call screen minigame
```

`games/rpg-demo` uses all of them with generated art.

## Building

```
python3 tools/build.py games/demo            # build/demo/ and dist/demo.xdc (engine bundled; webxdc has no network)
python3 tools/build.py games/demo --cdn      # index.html loads the engine from jsDelivr instead
```

From a CDN, `vn.js` resolves its lazy modules, `prelude.py` and the MicroPython wasm relative to itself, so only the
game's own files live next to `index.html`:

```html
<script type="module">
import 'https://cdn.jsdelivr.net/gh/lucky-edgelord/jade-vn-engine@main/engine/vn.js';
VN.boot({ canvas: document.querySelector('canvas') });
</script>
```

Tests drive headless Chrome with Playwright: `python3 tests/test_demo.py build/demo`.
