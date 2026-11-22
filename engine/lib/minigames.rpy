# vn-engine minigames. Include from game.toml with:  libs = "minigames"   (combine: libs = "rpg, minigames")
#
#   $ mg_setup("keypad", code="1996", tries=3, prompt="The safe wants four digits.")
#   call screen minigame
#   if _return:
#       "It clicks open."
#
# Kinds and their options (all return True on success, False on failure):
#   qte      keys="ZXC", count=5, time=1.3          press the key (or tap the prompt) before the ring closes
#   mash     target=25, time=5.0, key=" "           mash a key or tap until the bar fills
#   timing   rounds=3, speed=1.0, zone=0.16         lockpick: stop the needle inside the sweet spot
#   keypad   code="1234", tries=3, prompt=""        punch in a code
#   memory   pairs=6, faces=None, moves=None        flip cards to find pairs (faces: list of displayables)
#   slide    size=3, image=None, shuffle=60         slide tiles back into order
#   simon    length=5                               repeat the flashing sequence
# Style with MG_STYLE (colours, font). Sounds: MG_SOUNDS = {"good": ..., "bad": ..., "tick": ..., "win": ..., "lose": ...}

init -5 python:
    MG = {}
    MG_STYLE = {"font": "sans-serif", "accent": "#ff6fa5", "ok": "#4ade80", "bad": "#ff4a5a", "panel": "#0b0910ee", "text": "#ffffff"}
    MG_SOUNDS = {}
    MG_DT = 0.033

    def mg_snd(k):
        s = MG_SOUNDS.get(k)
        if s:
            renpy.play(s)

    def mg_setup(kind, **kw):
        MG.clear()
        MG.update({"kind": kind, "t": 0.0, "done": None, "msg": kw.get("prompt", ""), "end_t": 0.0})
        if kind == "qte":
            MG.update({"keys": kw.get("keys", "ZXC"), "count": kw.get("count", 5), "time": kw.get("time", 1.3), "i": 0})
            mg_qte_next()
        elif kind == "mash":
            MG.update({"target": kw.get("target", 25), "time": kw.get("time", 5.0), "key": kw.get("key", " "), "n": 0.0})
        elif kind == "timing":
            MG.update({"rounds": kw.get("rounds", 3), "speed": kw.get("speed", 1.0), "zone": kw.get("zone", 0.16), "i": 0, "pos": 0.0, "dir": 1})
            mg_timing_zone()
        elif kind == "keypad":
            MG.update({"code": str(kw.get("code", "1234")), "tries": kw.get("tries", 3), "entry": ""})
        elif kind == "memory":
            p = kw.get("pairs", 6)
            faces = kw.get("faces") or [None] * p
            deck = []
            for i in range(p):
                deck += [i, i]
            for i in range(len(deck) - 1, 0, -1):
                j = randint(0, i)
                deck[i], deck[j] = deck[j], deck[i]
            MG.update({"deck": deck, "faces": faces, "open": [], "found": [], "moves": 0, "limit": kw.get("moves"), "hide_at": None})
        elif kind == "slide":
            n = kw.get("size", 3)
            tiles = list(range(n * n))
            MG.update({"n": n, "tiles": tiles, "image": kw.get("image")})
            blank = n * n - 1
            for _ in range(kw.get("shuffle", 60)):
                nb = mg_slide_neighbours(tiles.index(blank))
                mg_slide_swap(choice(nb), quiet=True)
        elif kind == "simon":
            MG.update({"seq": [randint(0, 3) for _ in range(kw.get("length", 5))], "shown": 0, "lit": -1, "input": [], "phase": "show", "step_t": 0.0, "len": 1})

    def mg_end(ok, msg=None):
        if MG.get("done") is not None:
            return
        MG["done"] = bool(ok)
        MG["end_t"] = MG["t"]
        if msg:
            MG["msg"] = msg
        mg_snd("win" if ok else "lose")

    def mg_tick():
        MG["t"] += MG_DT
        k = MG["kind"]
        if MG["done"] is not None:
            if MG["t"] - MG["end_t"] > 1.1:
                raise _Ctl("return", MG["done"])
            return
        if k == "qte":
            if MG["t"] - MG["start"] > MG["time"]:
                mg_snd("bad")
                mg_end(False, "Too slow!")
        elif k == "mash":
            MG["n"] = max(0.0, MG["n"] - MG_DT * 1.2)
            if MG["t"] > MG["time"]:
                mg_end(False, "Not strong enough...")
        elif k == "timing":
            MG["pos"] += MG["dir"] * MG_DT * MG["speed"] * (1.0 + 0.35 * MG["i"])
            if MG["pos"] > 1.0:
                MG["pos"], MG["dir"] = 1.0, -1
            if MG["pos"] < 0.0:
                MG["pos"], MG["dir"] = 0.0, 1
        elif k == "memory":
            if MG["hide_at"] is not None and MG["t"] >= MG["hide_at"]:
                MG["open"] = []
                MG["hide_at"] = None
        elif k == "simon":
            mg_simon_tick()

    # ---- qte
    def mg_qte_next():
        MG["want"] = MG["keys"][randint(0, len(MG["keys"]) - 1)]
        MG["start"] = MG["t"]
        MG["slot"] = (randint(300, 980), randint(220, 460))

    def mg_qte_press(k):
        if MG["done"] is not None:
            return
        if k.upper() == MG["want"].upper() or k == "tap":
            mg_snd("good")
            MG["i"] += 1
            if MG["i"] >= MG["count"]:
                mg_end(True, "Done!")
            else:
                mg_qte_next()
        else:
            mg_snd("bad")
            mg_end(False, "Wrong key!")

    # ---- mash
    def mg_mash():
        if MG["done"] is not None:
            return
        MG["n"] += 1
        mg_snd("tick")
        if MG["n"] >= MG["target"]:
            mg_end(True, "Made it!")

    # ---- timing
    def mg_timing_zone():
        z = MG["zone"] * (1.0 - 0.15 * MG["i"])
        c = 0.15 + renpy.random() * (0.85 - z)
        MG["zlo"], MG["zhi"] = c, c + z

    def mg_timing_stop():
        if MG["done"] is not None:
            return
        if MG["zlo"] <= MG["pos"] <= MG["zhi"]:
            mg_snd("good")
            MG["i"] += 1
            if MG["i"] >= MG["rounds"]:
                mg_end(True, "Click!")
            else:
                mg_timing_zone()
        else:
            mg_snd("bad")
            mg_end(False, "Snap!")

    # ---- keypad
    def mg_key(d):
        if MG["done"] is not None:
            return
        mg_snd("tick")
        if d == "C":
            MG["entry"] = ""
        elif d == "OK":
            if MG["entry"] == MG["code"]:
                mg_end(True, "ACCESS GRANTED")
            else:
                MG["tries"] -= 1
                MG["entry"] = ""
                mg_snd("bad")
                if MG["tries"] <= 0:
                    mg_end(False, "LOCKED OUT")
                else:
                    MG["msg"] = "WRONG CODE  (%d left)" % MG["tries"]
        elif len(MG["entry"]) < len(MG["code"]):
            MG["entry"] += d

    # ---- memory
    def mg_flip(i):
        if MG["done"] is not None or i in MG["found"] or i in MG["open"] or MG["hide_at"] is not None:
            return
        mg_snd("tick")
        MG["open"].append(i)
        if len(MG["open"]) == 2:
            MG["moves"] += 1
            a, b = MG["open"]
            if MG["deck"][a] == MG["deck"][b]:
                MG["found"] += [a, b]
                MG["open"] = []
                mg_snd("good")
                if len(MG["found"]) == len(MG["deck"]):
                    mg_end(True, "All pairs in %d moves!" % MG["moves"])
            else:
                MG["hide_at"] = MG["t"] + 0.8
            if MG["limit"] and MG["moves"] >= MG["limit"] and MG["done"] is None and len(MG["found"]) < len(MG["deck"]):
                mg_end(False, "Out of moves.")

    # ---- slide
    def mg_slide_neighbours(i):
        n = MG["n"]
        x, y = i % n, i // n
        out = []
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            if 0 <= x + dx < n and 0 <= y + dy < n:
                out.append((y + dy) * n + x + dx)
        return out

    def mg_slide_swap(i, quiet=False):
        t = MG["tiles"]
        blank = MG["n"] * MG["n"] - 1
        b = t.index(blank)
        if i not in mg_slide_neighbours(b):
            return
        t[i], t[b] = t[b], t[i]
        if not quiet:
            mg_snd("tick")
            if t == list(range(len(t))):
                mg_end(True, "Solved!")

    # ---- simon
    def mg_simon_tick():
        if MG["phase"] != "show":
            return
        MG["step_t"] += MG_DT
        k = int(MG["step_t"] / 0.6)
        if k >= MG["len"]:
            if MG["step_t"] > MG["len"] * 0.6 + 0.2:
                MG["phase"], MG["lit"], MG["input"] = "input", -1, []
            else:
                MG["lit"] = -1
            return
        MG["lit"] = MG["seq"][k] if (MG["step_t"] % 0.6) < 0.4 else -1

    def mg_simon_press(i):
        if MG["phase"] != "input" or MG["done"] is not None:
            return
        MG["input"].append(i)
        MG["lit"] = i
        if MG["seq"][len(MG["input"]) - 1] != i:
            mg_end(False, "Wrong!")
            return
        mg_snd("good")
        if len(MG["input"]) == MG["len"]:
            if MG["len"] == len(MG["seq"]):
                mg_end(True, "Perfect!")
            else:
                MG["len"] += 1
                MG["phase"], MG["step_t"] = "show", -0.5


screen minigame():
    modal True
    zorder 70
    $ S = MG_STYLE
    $ k = MG.get("kind")
    add Solid("#000000b0")
    timer MG_DT repeat True action Function(mg_tick)
    if MG.get("msg"):
        text MG["msg"] xcenter 0.5 ypos 40 size 30 font S["font"] color (S["ok"] if MG.get("done") else S["bad"] if MG.get("done") is False else S["text"]) outlines 2
    if k == "qte":
        $ left = max(0.0, 1.0 - (MG["t"] - MG["start"]) / MG["time"])
        $ x, y = MG["slot"]
        button:
            area (x - 80, y - 80, 160, 160)
            background Solid(S["accent"], xysize=(160, 160), radius="circle")
            action Function(mg_qte_press, "tap")
        add Solid("#ffffff", xysize=(int(40 + 200 * left), int(40 + 200 * left)), radius="circle") xcenter x ycenter y alpha 0.25
        text MG["want"].upper() xcenter x ycenter y size 72 font S["font"] color "#ffffff" bold True outlines 3
        text ("%d / %d" % (MG["i"], MG["count"])) xcenter 0.5 ypos 640 size 24 font S["font"] color S["text"]
        for ch in MG["keys"]:
            key ch.lower() action Function(mg_qte_press, ch)
            key ch.upper() action Function(mg_qte_press, ch)
    elif k == "mash":
        add Solid("#ffffff22", xysize=(800, 50)) pos (240, 340)
        add Solid(S["accent"], xysize=(max(1, int(800 * min(1.0, MG["n"] / MG["target"]))), 50)) pos (240, 340)
        text ("MASH!  %.1fs" % max(0.0, MG["time"] - MG["t"])) xcenter 0.5 ypos 260 size 40 font S["font"] color S["text"] bold True outlines 2
        button:
            area (0, 400, 1280, 320)
            action Function(mg_mash)
        text "Tap here / press SPACE" xcenter 0.5 ypos 520 size 24 font S["font"] color "#ffffffaa"
        key MG["key"] action Function(mg_mash)
        key "K_SPACE" action Function(mg_mash)
    elif k == "timing":
        add Solid("#ffffff22", xysize=(900, 60)) pos (190, 330)
        add Solid(S["ok"], xysize=(int(900 * (MG["zhi"] - MG["zlo"])), 60)) pos (190 + int(900 * MG["zlo"]), 330) alpha 0.75
        add Solid("#ffffff", xysize=(8, 90)) pos (186 + int(900 * MG["pos"]), 315)
        text ("Pin %d of %d" % (min(MG["i"] + 1, MG["rounds"]), MG["rounds"])) xcenter 0.5 ypos 250 size 30 font S["font"] color S["text"]
        button:
            area (0, 420, 1280, 300)
            action Function(mg_timing_stop)
        text "Tap / SPACE inside the green" xcenter 0.5 ypos 520 size 24 font S["font"] color "#ffffffaa"
        key "K_SPACE" action Function(mg_timing_stop)
        key "K_RETURN" action Function(mg_timing_stop)
    elif k == "keypad":
        add Solid(S["panel"], xysize=(420, 560)) pos (430, 100)
        add Solid("#0a1a10", xysize=(360, 70)) pos (460, 130)
        text (MG["entry"] + "_" * (len(MG["code"]) - len(MG["entry"]))) xcenter 0.5 ypos 140 size 48 font S["font"] color "#7dff9a"
        grid 3 4:
            pos (470, 230) spacing 12
            for d in ("1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "OK"):
                textbutton d action Function(mg_key, d) xysize (104, 92) background Solid("#2a2433") hover_background Solid(S["accent"]) text_size 34 text_font S["font"] text_color "#ffffff" text_xalign 0.5
        for d in "0123456789":
            key d action Function(mg_key, d)
        key "K_RETURN" action Function(mg_key, "OK")
        key "K_BACKSPACE" action Function(mg_key, "C")
    elif k == "memory":
        $ cols = 4 if len(MG["deck"]) <= 12 else 6
        $ cw, ch = 150, 170
        $ ox = int(640 - cols * (cw + 14) / 2)
        for i, v in enumerate(MG["deck"]):
            $ up = i in MG["open"] or i in MG["found"]
            $ cx, cy = ox + (i % cols) * (cw + 14), 110 + (i // cols) * (ch + 14)
            button:
                area (cx, cy, cw, ch)
                background Solid(("#f3e9ff" if up else S["accent"]), xysize=(cw, ch))
                action Function(mg_flip, i)
                if up and MG["faces"][v] is not None:
                    add MG["faces"][v] xcenter 0.5 ycenter 0.5
                elif up:
                    text str(v + 1) xcenter 0.5 ycenter 0.5 size 64 font S["font"] color "#2a1030" bold True
                else:
                    text "?" xcenter 0.5 ycenter 0.5 size 56 font S["font"] color "#ffffff"
        text ("Moves: %d%s" % (MG["moves"], (" / %d" % MG["limit"]) if MG["limit"] else "")) xcenter 0.5 ypos 680 size 24 font S["font"] color S["text"]
    elif k == "slide":
        $ n = MG["n"]
        $ sz = int(540 / n)
        for i, v in enumerate(MG["tiles"]):
            if v != n * n - 1 or MG.get("done"):
                button:
                    area (370 + (i % n) * sz, 110 + (i // n) * sz, sz - 4, sz - 4)
                    background Solid("#2a2433", xysize=(sz - 4, sz - 4))
                    hover_background Solid("#3d3348", xysize=(sz - 4, sz - 4))
                    action Function(mg_slide_swap, i)
                    text str(v + 1) xcenter 0.5 ycenter 0.5 size int(sz / 2.5) font S["font"] color "#ffffff"
    elif k == "simon":
        $ cols4 = ("#e0364a", "#2f9df4", "#3fd07a", "#f6c945")
        for i in range(4):
            $ x, y = (420 if i % 2 == 0 else 650), (130 if i < 2 else 360)
            button:
                area (x, y, 210, 210)
                background Solid(cols4[i], xysize=(210, 210))
                action Function(mg_simon_press, i)
                if MG["lit"] == i:
                    add Solid("#ffffffaa", xysize=(210, 210))
        text ("Watch..." if MG["phase"] == "show" else "Your turn (%d/%d)" % (len(MG["input"]), MG["len"])) xcenter 0.5 ypos 620 size 28 font S["font"] color S["text"]
