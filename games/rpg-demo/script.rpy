# vn-engine RPG demo: overworld (tile scroller), map mode, a dark cave with torchlight, Phantasy-Star-style
# battles, a faux-3D house tour, and minigames. Everything here is original and generated.

define config.name = "vn-engine RPG demo"
define config.fonts = {"PS2P": "fonts/press-start-2p-latin-400-normal.woff2"}
define gui.font = "PS2P"
define gui.text_size = 18
define gui.name_size = 16
define gui.accent = "#ffd34a"
define BATTLE_FONT = "PS2P"
define MG_STYLE = {"font": "PS2P", "accent": "#3f63d8", "ok": "#4ade80", "bad": "#ff4a5a", "panel": "#0b0910ee", "text": "#ffffff"}

define alis = Character("Alis", who_color="#ffd34a")
define elder = Character("Elder", who_color="#9fb4ff")
define kid = Character("Arcade kid", who_color="#ff9fc4")

default pos = {"x": 5, "y": 6, "face": "down", "rev": 0}
default where = "world"
default tour_pos = {"node": "entry", "yaw": 0, "rev": 0}
default chest_open = False
default knows_code = False
default steps = 0

init python:
    TILESET = Tileset("tiles.png", size=16, cols=8)
    HERO = CharSheet("people.png", size=16, cols=3, row=0)

    def npcs_here():
        if where == "world":
            return [{"id": "elder", "x": 9, "y": 7, "sprite": CharSheet("people.png", row=4), "wander": 2},
                    {"id": "kid", "x": 16, "y": 12, "sprite": CharSheet("people.png", row=8), "wander": False, "face": "left"}]
        return [{"id": "ghost_girl", "x": 20, "y": 9, "sprite": CharSheet("people.png", row=12), "wander": 1}]

    def light_here():
        if where != "cave":
            return None
        return {"ambient": "#05030a", "dark": 0.92,
                "lights": [{"x": x, "y": y, "radius": 4.5, "color": "#ff9a3a", "flicker": 0.3, "seed": i, "tint": 0.3, "shadows": True, "core": 6}
                           for i, (x, y) in enumerate(CAVE_TORCHES)],
                "player": {"radius": 3.2, "color": "#ffe0b0", "tint": 0.12, "shadows": True}}

    def warp(m, x, y, face="down"):
        global where
        where = m
        pos.update({"x": x, "y": y, "face": face, "rev": pos.get("rev", 0) + 1})

    def map_event():
        global steps
        e = _widget_event or {}
        t, ch = e.get("type"), e.get("tile")
        if t == "step":
            steps += 1
            if where == "world" and ch == "\"" and randint(1, 9) == 1:
                Return(("battle", choice([["slime"], ["slime", "slime"], ["scorpion"], ["slime", "scorpion"]]), "bg_field.jpg"))()
            if where == "cave" and ch == "U":
                Return(("warp", "world", 37, 5))()
            if where == "cave" and randint(1, 12) == 1:
                Return(("battle", choice([["bat"], ["bat", "bat"], ["ghost"], ["bat", "ghost"]]), "bg_cave.jpg"))()
        elif t == "bump":
            if ch == "D":
                Return(("house",))()
            if ch == "C":
                Return(("warp", "cave", 1, 2))()
            if e.get("npc"):
                Return(("npc", e["npc"]))()
        elif t == "interact":
            if e.get("npc"):
                Return(("npc", e["npc"]))()
            if ch in ("S", "X", "o"):
                Return(("thing", ch))()
        return None

    def tour_event():
        e = _widget_event or {}
        if e.get("type") == "hotspot":
            Return(("look", e.get("id")))()
        return None

screen overworld():
    add TileMap(where, state="pos", tileset=TILESET, player=HERO, npcs=npcs_here(), tile=48, speed=5.5, light=light_here()) action Function(map_event)
    # minimap in the corner; M opens map mode
    add Solid("#000a", xysize=(208, 208)) pos (1056, 16)
    add MapView(where, state="pos", radius=10) pos (1060, 20) xysize (200, 200)
    text "M: map" pos (1086, 228) size 12 color "#fff" outlines 2
    hbox:
        pos (20, 16) spacing 24
        for m in party:
            text ("%s  HP %d/%d" % (m["name"], m["hp"], m["mhp"])) size 14 color "#fff" outlines 2
    text ("MESETA %d" % gold) pos (20, 44) size 14 color "#ffd34a" outlines 2
    key "m" action Show("map_mode")
    key "M" action Show("map_mode")

screen map_mode():
    modal True
    zorder 50
    add Solid("#000000e0")
    text ("WORLD MAP" if where == "world" else "CAVE") xcenter 0.5 ypos 24 size 28 color "#ffd34a" outlines 2
    $ mk = [{"x": 5, "y": 4, "label": "Home", "color": "#ffd34a"}, {"x": 37, "y": 4, "label": "Cave", "color": "#ff7a7a"}, {"x": 10, "y": 4, "label": "Sign"}] if where == "world" else [{"x": 1, "y": 1, "label": "Exit", "color": "#ffd34a"}]
    add MapView(where, state="pos", markers=mk) pos (140, 80) xysize (1000, 580)
    textbutton "CLOSE" action Hide("map_mode") xcenter 0.5 ypos 676 text_size 18
    key "m" action Hide("map_mode")
    key "M" action Hide("map_mode")
    key "K_ESCAPE" action Hide("map_mode")

screen house_tour():
    add Tour("house", state="tour_pos") action Function(tour_event)
    text "Drag to look around. Tap the floor rings to walk." xcenter 0.5 ypos 680 size 13 color "#fff" outlines 2

label start:
    python:
        add_member("Alis", hp=24, mp=6, atk=9, df=5, agi=8, spells=["heal", "fire"])
        add_member("Myau", hp=18, mp=10, atk=7, df=4, agi=11, spells=["wind", "heal"])
        give_item("potion", 3)
        give_item("escape", 1)
        define_enemy("slime", name="Blue Slime", sprite="slime.png", hp=10, atk=7, df=2, agi=3, xp=4, gold=5, zoom=0.9, talk="Blorp.", drops="potion")
        define_enemy("scorpion", name="Scorpion", sprite="scorpion.png", hp=16, atk=10, df=5, agi=5, xp=7, gold=9, zoom=0.9)
        define_enemy("bat", name="Cave Bat", sprite="bat.png", hp=12, atk=9, df=3, agi=12, xp=6, gold=6, zoom=0.9, flees=0.1)
        define_enemy("ghost", name="Wisp", sprite="ghost.png", hp=20, mp=12, atk=8, df=6, agi=7, xp=12, gold=14, spells=["fire"], talk="...cold...", zoom=1.0)
    scene black
    alis "Palma, year 342. The cave in the north hums at night."
    alis "Arrow keys or WASD to walk, or just tap where to go. Enter / Space / Z, or tap someone, to talk."
    jump explore

label explore:
    call screen overworld
    $ ev = _return
    if ev is None:
        jump explore
    if ev[0] == "battle":
        $ start_battle(ev[1], bg=ev[2])
        call battle
        if battle_result == "lose":
            jump defeat
    elif ev[0] == "warp":
        $ warp(ev[1], ev[2], ev[3])
        with fade
    elif ev[0] == "house":
        jump house
    elif ev[0] == "npc":
        call expression ("npc_" + ev[1])
    elif ev[0] == "thing":
        call expression ("thing_" + {"S": "sign", "X": "chest", "o": "well"}[ev[1]])
    jump explore

label npc_elder:
    elder "The house behind me is empty now. Look around if you like - the study door sticks."
    elder "If the cave scares you, carry a light. The torches never go out down there."
    return

label npc_ghost_girl:
    "A pale girl stands in the dark. She points at the far chest."
    "\"Four numbers,\" she whispers. \"He always wrote them down.\""
    return

label thing_sign:
    "NORTH: CAVE OF WHISPERS.  WEST: HOME."
    return

label thing_well:
    "You drop a pebble. You never hear it land."
    $ mg_setup("mash", target=22, time=4.0)
    "Pull the bucket up!"
    call screen minigame
    if _return:
        $ give_item("potion")
        "There's a Monomate tied to the rope."
    else:
        "The rope slips away."
    return

label thing_chest:
    if chest_open:
        "It's empty."
        return
    "An iron chest with a four-digit lock."
    $ mg_setup("keypad", code="1987", tries=3, prompt=("The study note said 1987..." if knows_code else "A four-digit code."))
    call screen minigame
    if _return:
        $ chest_open = True
        $ give_item("potion", 2)
        $ gold += 100
        "Inside: two Monomates and 100 meseta."
    else:
        "The lock holds."
    return

label npc_kid:
    kid "Wanna play? Winner gets 20 meseta."
    menu:
        "Lockpick":
            $ mg_setup("timing", rounds=3, speed=1.1)
        "Quick-time":
            $ mg_setup("qte", keys="ZXC", count=5, time=1.4)
        "Memory":
            $ mg_setup("memory", pairs=6, moves=14)
        "Sliding puzzle":
            $ mg_setup("slide", size=3, shuffle=40)
        "Simon":
            $ mg_setup("simon", length=4)
        "Not now":
            return
    call screen minigame
    if _return:
        $ gold += 20
        kid "No way! Fine, here."
    else:
        kid "Ha! Again sometime."
    return

label house:
    $ tour_pos.update({"node": "entry", "yaw": 0, "rev": tour_pos.get("rev", 0) + 1})
    scene black with fade
label house_loop:
    call screen house_tour
    $ ev = _return
    if ev and ev[0] == "look":
        if ev[1] == "leave":
            $ warp("world", 5, 5, "down")
            scene black with fade
            jump explore
        elif ev[1] == "painting":
            "A red painting of the north cave. Someone scratched 19 into the frame."
        elif ev[1] == "fridge":
            "Empty, except for a note: \"buy eggs\"."
        elif ev[1] == "note":
            $ knows_code = True
            "A note in a shaky hand: \"...87. Don't forget the first half is on the painting.\""
        elif ev[1] == "books":
            "Mostly star charts. One page is torn out."
    jump house_loop

label defeat:
    "Everything goes dark..."
    python:
        for m in party:
            m["hp"] = m["mhp"]
            m["mp"] = m["mmp"]
        gold = gold // 2
        warp("world", 5, 6)
    "You wake up at home. Half your meseta is gone."
    jump explore
