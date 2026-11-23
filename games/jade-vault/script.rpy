# Jade's Vault - a jade-vn-engine test game built from jade-vault's Vault Loci assets.
# Walk Jade through the vault (D-pad / WASD / tap), discover the eleven loci, light presets like Loci's
# (L to cycle), map mode (M), Jade herself in Live2D at the Comms Desk, a keypad on the Core Vault, VHS mode (V).

define config.name = "Jade's Vault"
define config.fonts = {"Silk": [{"src": "fonts/silkscreen-latin-400-normal.woff2"}, {"src": "fonts/silkscreen-latin-700-normal.woff2", "weight": "700"}], "Mono": [{"src": "fonts/jetbrains-mono-latin-400-normal.woff2"}, {"src": "fonts/jetbrains-mono-latin-600-normal.woff2", "weight": "600"}]}
define gui.font = "Mono"
define gui.text_size = 22
define gui.name_size = 20
define gui.accent = "#3cffaa"
define gui.hover_color = "#3cffaa"
define gui.idle_color = "#cfe9dd"
define MG_STYLE = {"font": "Silk", "accent": "#1f8a5c", "ok": "#3cffaa", "bad": "#ff5a6a", "panel": "#081210ee", "text": "#e6fff4"}

define jade = Character("Jade", who_color="#3cffaa")

# Jade's Live2D model is Jade Vault's own (tools/extract_jade_live2d.py). The Cubism Core runtime is Live2D's: it loads from
# Live2D's site; for offline play run tools/fetch_live2d.sh and delete the next line.
define config.live2d_core = "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js"
image jade live2d = Live2D("jade-live2d/jadecat.model3.json", id="jade", motion=None, look="mouse", zoom=1.0)

default pos = {"x": 54, "y": 53, "face": "up", "rev": 0}
default found = []
default light_mode = "dim"
default vhs = False
default vault_open = False

init python:
    CELL = 24
    WALK = [[112, 655, 2462, 1342], [975, 572, 1600, 672], [1205, 1330, 1395, 1438]]
    BLOCK = [[112, 862, 1108, 1105], [118, 1215, 1100, 1345], [1478, 895, 2030, 1105], [2155, 848, 2465, 1095], [1500, 1175, 2462, 1345]]
    OCC = [b + [80] for b in BLOCK] + [[-300, -300, 975, 655, 130], [1600, -300, 2900, 655, 130], [975, -300, 1600, 572, 130],
           [-300, -300, 112, 1800, 130], [2462, -300, 2900, 1800, 130], [-300, 1342, 1205, 1800, 130], [1395, 1342, 2900, 1800, 130]]
    SCREENS = [[1405, 375, 170, .9], [910, 335, 110, .6], [800, 430, 95, .5], [1760, 170, 150, .8], [2020, 330, 150, .85], [2170, 335, 140, .8],
               [1870, 470, 130, .7], [2040, 470, 160, .95], [2150, 470, 150, .85], [1655, 935, 120, .75], [1760, 950, 120, .75], [1870, 945, 120, .75],
               [1520, 990, 100, .6], [1760, 1215, 130, .75], [1870, 1215, 130, .75], [590, 1255, 110, .75], [700, 1255, 110, .75], [815, 1255, 110, .75],
               [925, 1255, 110, .75], [165, 990, 120, .55], [270, 990, 120, .55], [700, 990, 110, .5], [815, 990, 110, .5], [930, 990, 110, .5],
               [1045, 990, 110, .5], [595, 985, 80, .55], [180, 605, 90, .65], [275, 520, 85, .55], [275, 610, 85, .55], [380, 610, 85, .55],
               [1160, 115, 90, .4], [2340, 300, 70, .3]]
    register_data("vault", map_from_rects("vault.webp", 2576, 1438, cell=CELL, walk=WALK, block=BLOCK, occ=OCC))
    JADE = FrameSheet("jade.webp", 181, 278, cols=4, idle={"down": [0, 0], "up": [2, 0], "right": [3, 0], "left": [3, 0, 1]},
                      walk={"down": 1, "up": 2, "right": 3, "left": [3, 0, 1]}, height=150, blink=2, glow="rgba(60,255,170,.85)")
    LIGHT = {"lit": (0.25, 0.0), "dim": (0.64, 1.0), "black": (0.94, 0.6)}   # darkness, screen-glow strength

    def lighting():
        dark, glow = LIGHT[light_mode]
        ls = [{"x": x / CELL - 0.5, "y": y / CELL - 0.5, "radius": r / CELL * 1.25, "color": "#3cffaa", "cut": 0.55 * k * glow, "tint": 0.16 * k * glow,
               "flicker": 0.08, "seed": i, "falloff": 0.4} for i, (x, y, r, k) in enumerate(SCREENS)] if glow else []
        return {"ambient": "#020806", "dark": dark, "blur": 10, "lights": ls,
                "player": {"radius": 340.0 / CELL, "color": "#c8ffe4", "cut": 1.0, "tint": 0.10, "shadows": True, "dust": 18}}

    def near_locus():
        px, py = (pos["x"] + 0.5) * CELL, (pos["y"] + 0.5) * CELL
        best = None
        for l in LOCI:
            d = ((l["s"][0] - px) ** 2 + (l["s"][1] - py) ** 2) ** 0.5
            if d < 110 and (best is None or d < best[0]):
                best = (d, l)
        return best[1] if best else None

    def vault_event():
        e = _widget_event or {}
        if e.get("type") in ("step", "interact"):
            l = near_locus()
            if l and l["id"] not in found:
                found.append(l["id"])
                renpy.notify("Found: " + l["name"] + "  (" + str(len(found)) + "/11)")
            if e.get("type") == "interact" and l:
                Return(("locus", l["id"]))()

    def cycle_light():
        global light_mode
        light_mode = {"lit": "dim", "dim": "black", "black": "lit"}[light_mode]
        renpy.notify("Lights: " + light_mode)

    def toggle_vhs():
        global vhs
        vhs = not vhs
        if vhs:
            renpy.fx("vectoria")
        else:
            renpy.fx_off("vectoria")

    def locus(i):
        for l in LOCI:
            if l["id"] == i:
                return l

screen vault():
    add TileMap("vault", state="pos", player=JADE, tile=22, speed=9.0, light=lighting()) action Function(vault_event)
    add Solid("#000b", xysize=(268, 158)) pos (996, 16)
    add MapView("vault", state="pos", markers=[{"x": l["s"][0] / CELL, "y": l["s"][1] / CELL, "color": ("#3cffaa" if l["id"] in found else "#557766")} for l in LOCI]) pos (1000, 20) xysize (260, 150)
    text ("LOCI %d/11   L: light (%s)   M: map   V: vhs" % (len(found), light_mode)) pos (20, 18) font "Silk" size 14 color "#3cffaa" outlines 2 outline_color "#000"
    $ l = near_locus()
    if l:
        text (l["glyph"] + " " + l["name"] + " - " + l["sub"] + "   [Enter / tap Jade]") xcenter 0.5 ypos 664 font "Silk" size 16 color "#e6fff4" outlines 2 outline_color "#000"
    key "l" action Function(cycle_light)
    key "L" action Function(cycle_light)
    key "v" action Function(toggle_vhs)
    key "V" action Function(toggle_vhs)
    key "m" action Show("vault_map")
    key "M" action Show("vault_map")

screen vault_map():
    modal True
    zorder 50
    add Solid("#000000e6")
    text "VAULT LOCI" xcenter 0.5 ypos 22 font "Silk" size 30 color "#3cffaa"
    add MapView("vault", state="pos", markers=[{"x": l["s"][0] / CELL, "y": l["s"][1] / CELL, "label": (l["name"] if l["id"] in found else "?"), "color": ("#3cffaa" if l["id"] in found else "#557766")} for l in LOCI]) pos (60, 70) xysize (1160, 600)
    textbutton "CLOSE" action Hide("vault_map") xcenter 0.5 ypos 680 text_font "Silk"
    key "m" action Hide("vault_map")
    key "M" action Hide("vault_map")
    key "K_ESCAPE" action Hide("vault_map")

image vault_view = "vault.webp"
transform vault_dim:
    zoom 0.497
    alpha 0.45

label start:
    scene vault_view at vault_dim with dissolve
    show jade live2d at truecenter with dissolve
    jade "Welcome to the vault. Eleven places to keep what matters - walk me around and we'll find them."
    jade "WASD, arrows or a tap on the floor. Stand near a place and press Enter, or tap me."
    hide jade live2d with dissolve
    jump explore

label explore:
    call screen vault
    $ ev = _return
    if ev and ev[0] == "locus":
        call locus_any
    jump explore

label locus_any:
    $ L = locus(ev[1])
    $ line = L["glyph"] + " " + L["name"] + ". " + L["desc"]
    jade "[line]"
    if ev[1] == "comms":
        jump guest_scene
    if ev[1] == "vault":
        jump core_vault
    $ items = "  • " + "\n  • ".join(L["items"])
    jade "Good for:\n[items]"
    return

label core_vault:
    if vault_open:
        jade "The round door stands open. It's a place to remember, not a lock."
        return
    jade "The round door wants a code. Four digits - the year the vault was built."
    $ mg_setup("keypad", code="2026", tries=3, prompt="CORE VAULT")
    call screen minigame
    if _return:
        $ vault_open = True
        $ renpy.fx("glow", amount=1.5, duration=1.0)
        jade "It opens. Inside: nothing but room. Put what matters here."
    else:
        jade "Locked out. Try again later."
    return

label guest_scene:
    jade "The Comms Desk has a big screen. Let me put my other self on it."
    scene black with dissolve
    show jade live2d at truecenter with dissolve
    jade "This is me in Live2D, the same model as in Jade Vault: Cubism, drawn live in WebGL."
    jade "Move your pointer and I'll look at it. I blink and breathe on my own, and my mouth follows a voice line."
    $ live2d("jade", expression=None)
    jade "That's all from the big screen. Back to the vault!"
    hide jade live2d with dissolve
    return
