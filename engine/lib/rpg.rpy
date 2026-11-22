# vn-engine RPG library: party, items, spells and first-person turn-based battles in the style of
# the original Phantasy Star (enemies facing you over a backdrop, black windows with light borders,
# FIGHT / MAGIC / ITEM / TALK / RUN). Include it from game.toml with:  libs = "rpg"
#
#   $ add_member("Alis", hp=16, mp=0, atk=8, df=5, agi=7, sprite="alis.png", spells=["heal"])
#   $ define_enemy("slime", name="Blue Slime", sprite="slime.png", hp=8, atk=6, df=2, agi=3, xp=3, gold=4)
#   $ start_battle(["slime", "slime"], bg="cave")      # bg: an image name, or None for the default backdrop
#   call battle
#   if battle_result == "lose":
#       jump game_over
#
# Everything is plain dicts in the store, so saves and rollback just work.

default party = []
default inventory = {}
default gold = 0
default battle_result = None
default B = {}

init -5 python:
    ENEMIES = {}
    SPELLS = {
        "heal": {"name": "HEAL", "mp": 3, "power": 20, "target": "ally", "kind": "heal"},
        "fire": {"name": "FIRE", "mp": 4, "power": 14, "target": "enemy", "kind": "damage"},
        "wind": {"name": "WIND", "mp": 6, "power": 10, "target": "all", "kind": "damage"},
    }
    ITEMS = {
        "potion": {"name": "Monomate", "power": 20, "target": "ally", "kind": "heal", "price": 10},
        "escape": {"name": "Escapipe", "target": "none", "kind": "escape", "price": 30},
    }
    XP_TABLE = [0, 0, 10, 25, 50, 90, 150, 240, 360, 520, 720, 1000]
    BATTLE_FONT = "sans-serif"
    BATTLE_SOUNDS = {}          # "hit", "miss", "magic", "win", "lose", "select" -> sound names

    def add_member(name, hp=16, mp=0, atk=8, df=5, agi=6, sprite=None, spells=(), growth=None, lvl=1):
        m = {"name": name, "hp": hp, "mhp": hp, "mp": mp, "mmp": mp, "atk": atk, "df": df, "agi": agi, "lvl": lvl,
             "xp": 0, "sprite": sprite, "spells": list(spells), "growth": growth or {"hp": 5, "mp": 2, "atk": 2, "df": 1, "agi": 1}}
        party.append(m)
        return m

    def define_enemy(key, name=None, sprite=None, hp=8, mp=0, atk=6, df=2, agi=4, xp=2, gold=2, spells=(), talk=None,
                     zoom=1.0, flees=0.0, drops=None):
        ENEMIES[key] = {"name": name or key.title(), "sprite": sprite, "hp": hp, "mp": mp, "atk": atk, "df": df, "agi": agi,
                        "xp": xp, "gold": gold, "spells": list(spells), "talk": talk, "zoom": zoom, "flees": flees, "drops": drops}

    def give_item(key, n=1):
        inventory[key] = inventory.get(key, 0) + n

    def alive(group):
        return [x for x in group if x["hp"] > 0]

    def bsnd(k):
        s = BATTLE_SOUNDS.get(k)
        if s:
            renpy.play(s)

    def start_battle(foes, bg=None, can_run=True, music=None):
        global battle_result
        es = []
        counts = {}
        for k in foes:
            e = dict(ENEMIES[k])
            counts[k] = counts.get(k, 0) + 1
            e["key"] = k
            e["mhp"] = e["hp"]
            e["flash"] = 0
            es.append(e)
        for e in es:
            if counts[e["key"]] > 1:
                counts[e["key"]] = counts[e["key"]]
        B.clear()
        B.update({"foes": es, "bg": bg, "can_run": can_run, "phase": "command", "actor": 0, "orders": [], "queue": [],
                  "msg": "", "sub": None, "pending": None, "shake": 0, "won_xp": 0, "won_gold": 0, "turn": 1})
        battle_result = None
        first = alive(party)
        B["actor"] = party.index(first[0]) if first else 0
        names = {}
        for e in es:
            names[e["name"]] = names.get(e["name"], 0) + 1
        B["msg"] = "  ".join(("%d %ss" % (v, k) if v > 1 else k) for k, v in names.items()) + (" appear!" if len(es) > 1 else " appears!")
        if music:
            renpy.play(music, channel="music", loop=True)

    # ---------------------------------------------------------------- choosing commands
    def cur_actor():
        return party[B["actor"]]

    def next_actor():
        i = B["actor"] + 1
        while i < len(party) and party[i]["hp"] <= 0:
            i += 1
        if i >= len(party):
            run_turn()
        else:
            B["actor"] = i
            B["phase"] = "command"
            B["sub"] = None

    def cmd(c):
        bsnd("select")
        a = cur_actor()
        if c == "fight":
            if len(alive(B["foes"])) == 1:
                order("fight", alive(B["foes"])[0])
            else:
                B["pending"] = ("fight", None)
                B["phase"] = "target"
        elif c == "magic":
            if not a["spells"]:
                B["msg"] = a["name"] + " knows no techniques."
                return
            B["sub"] = "magic"
        elif c == "item":
            if not [k for k, n in inventory.items() if n > 0]:
                B["msg"] = "There are no items."
                return
            B["sub"] = "item"
        elif c == "talk":
            order("talk", None)
        elif c == "run":
            order("run", None)

    def pick_spell(k):
        sp = SPELLS[k]
        a = cur_actor()
        if a["mp"] < sp["mp"]:
            B["msg"] = "Not enough MP."
            return
        choose_target(("magic", k), sp["target"])

    def pick_item(k):
        choose_target(("item", k), ITEMS[k]["target"])

    def choose_target(pending, target):
        B["sub"] = None
        if target == "enemy":
            if len(alive(B["foes"])) == 1:
                order(pending[0], alive(B["foes"])[0], pending[1])
            else:
                B["pending"] = pending
                B["phase"] = "target"
        elif target == "ally":
            B["pending"] = pending
            B["phase"] = "ally"
        else:
            order(pending[0], None, pending[1])

    def pick_target(t):
        p = B["pending"]
        B["pending"] = None
        order(p[0], t, p[1])

    def cancel():
        B["sub"] = None
        B["pending"] = None
        B["phase"] = "command"

    def order(kind, target, what=None):
        B["orders"].append({"who": cur_actor(), "kind": kind, "target": target, "what": what})
        next_actor()

    # ---------------------------------------------------------------- resolving a turn
    def say_(text, fx=None):
        B["queue"].append((text, fx))

    def dmg(att, dfn):
        base = att["atk"] - dfn["df"] // 2
        v = max(1, int(base * (0.8 + 0.4 * renpy.random())))
        crit = renpy.random() < 1.0 / 16
        return (v * 2 if crit else v), crit

    def hit(target, n, enemy_side):
        def f():
            target["hp"] = max(0, target["hp"] - n)
            if enemy_side:
                target["flash"] = 3
                bsnd("hit")
            else:
                B["shake"] = 1
                renpy.shake(0.35, 10)
                bsnd("hurt")
        return f

    def heal_fx(target, n):
        def f():
            target["hp"] = min(target["mhp"], target["hp"] + n)
            bsnd("magic")
        return f

    def run_turn():
        B["phase"] = "resolve"
        acts = list(B["orders"])
        for e in alive(B["foes"]):
            acts.append({"who": e, "kind": "enemy"})
        acts.sort(key=lambda a: -(a["who"]["agi"] + randint(0, 4)))
        B["orders"] = []
        for a in acts:
            act(a)
        say_(None, end_of_turn)
        B["msg"] = ""
        battle_next()

    def act(a):
        w = a["who"]
        if w["hp"] <= 0:
            return
        if a["kind"] == "fight":
            t = a["target"]
            if t is None or t["hp"] <= 0:
                al = alive(B["foes"])
                if not al:
                    return
                t = al[0]
            if renpy.random() < 0.06 + max(0, t["agi"] - w["agi"]) * 0.02:
                say_("%s attacks!  Missed!" % w["name"], lambda: bsnd("miss"))
                return
            n, crit = dmg(w, t)
            say_("%s attacks!%s  %s takes %d damage." % (w["name"], "  Critical hit!" if crit else "", t["name"], n), hit(t, n, True))
            say_(None, check_dead(t))
        elif a["kind"] == "magic":
            sp = SPELLS[a["what"]]
            if w["mp"] < sp["mp"]:
                say_("%s has no MP left." % w["name"])
                return
            w["mp"] -= sp["mp"]
            if sp["kind"] == "heal":
                t = a["target"] or w
                n = sp["power"] + randint(0, 4)
                say_("%s uses %s!  %s recovers %d HP." % (w["name"], sp["name"], t["name"], n), heal_fx(t, n))
            else:
                ts = alive(B["foes"]) if sp["target"] == "all" else [a["target"] if a["target"] and a["target"]["hp"] > 0 else (alive(B["foes"]) or [None])[0]]
                say_("%s uses %s!" % (w["name"], sp["name"]), lambda: renpy.fx("glow", amount=1.5, duration=0.5) or bsnd("magic"))
                for t in ts:
                    if t is None:
                        continue
                    n = sp["power"] + randint(0, 6) - t["df"] // 4
                    say_("%s takes %d damage." % (t["name"], n), hit(t, max(1, n), True))
                    say_(None, check_dead(t))
        elif a["kind"] == "item":
            it = ITEMS[a["what"]]
            if inventory.get(a["what"], 0) <= 0:
                return
            inventory[a["what"]] -= 1
            if it["kind"] == "heal":
                t = a["target"] or w
                say_("%s uses a %s.  %s recovers %d HP." % (w["name"], it["name"], t["name"], it["power"]), heal_fx(t, it["power"]))
            elif it["kind"] == "escape":
                say_("%s uses an %s!" % (w["name"], it["name"]), lambda: B.update({"fled": True}))
        elif a["kind"] == "talk":
            e = (alive(B["foes"]) or [None])[0]
            line = e and e.get("talk")
            say_("%s talks to %s." % (w["name"], e["name"] if e else "nobody"))
            say_(line or "It doesn't respond.")
        elif a["kind"] == "run":
            if not B["can_run"]:
                say_("There's no escape!")
                return
            fast = max(x["agi"] for x in alive(B["foes"])) if alive(B["foes"]) else 0
            if renpy.random() < 0.5 + (w["agi"] - fast) * 0.06:
                say_("%s's party runs away!" % w["name"], lambda: B.update({"fled": True}))
            else:
                say_("%s tries to run... but can't get away!" % w["name"])
        elif a["kind"] == "enemy":
            al = alive(party)
            if not al:
                return
            if w.get("flees") and renpy.random() < w["flees"]:
                say_("%s runs away." % w["name"], lambda: w.update({"hp": 0, "fled": 1}))
                return
            sp = [s for s in w.get("spells", []) if SPELLS[s]["kind"] == "damage" and w["mp"] >= SPELLS[s]["mp"]]
            t = choice(al)
            if sp and renpy.random() < 0.35:
                s = SPELLS[choice(sp)]
                w["mp"] -= s["mp"]
                n = max(1, s["power"] + randint(0, 4) - t["df"] // 4)
                say_("%s casts %s!  %s takes %d damage." % (w["name"], s["name"], t["name"], n), hit(t, n, False))
            else:
                n, crit = dmg(w, t)
                say_("%s attacks!%s  %s takes %d damage." % (w["name"], "  A terrible blow!" if crit else "", t["name"], n), hit(t, n, False))
            say_(None, check_dead_member(t))

    def check_dead(t):
        def f():
            if t["hp"] <= 0 and not t.get("dead_said"):
                t["dead_said"] = 1
                B["queue"].insert(0, ("%s is defeated!" % t["name"], None))
                B["won_xp"] += t["xp"]
                B["won_gold"] += t["gold"]
        return f

    def check_dead_member(t):
        def f():
            if t["hp"] <= 0 and not t.get("dead_said"):
                t["dead_said"] = 1
                B["queue"].insert(0, ("%s has fallen!" % t["name"], None))
        return f

    def end_of_turn():
        for m in party:
            m.pop("dead_said", None)
        if B.get("fled"):
            finish("run")
        elif not alive(B["foes"]):
            win()
        elif not alive(party):
            B["queue"].append(("The party has been defeated...", lambda: bsnd("lose")))
            B["queue"].append((None, lambda: finish("lose")))
        else:
            B["turn"] += 1
            B["phase"] = "command"
            B["actor"] = party.index(alive(party)[0])
            B["msg"] = ""

    def win():
        global gold
        bsnd("win")
        xp, g = B["won_xp"], B["won_gold"]
        gold += g
        B["phase"] = "resolve"
        B["queue"].append(("Victory!  %d experience points.  %d meseta." % (xp, g), None))
        for m in alive(party):
            m["xp"] += xp
            while m["lvl"] + 1 < len(XP_TABLE) and m["xp"] >= XP_TABLE[m["lvl"] + 1]:
                m["lvl"] += 1
                gr = m["growth"]
                for k in ("atk", "df", "agi"):
                    m[k] += gr.get(k, 1)
                m["mhp"] += gr.get("hp", 4)
                m["mmp"] += gr.get("mp", 1)
                m["hp"] = m["mhp"]
                m["mp"] = m["mmp"]
                B["queue"].append(("%s is now level %d!" % (m["name"], m["lvl"]), lambda: bsnd("magic")))
        for e in B["foes"]:
            if e.get("drops") and renpy.random() < 0.3:
                give_item(e["drops"])
                B["queue"].append(("Found a %s." % ITEMS[e["drops"]]["name"], None))
        B["queue"].append((None, lambda: finish("win")))

    def finish(result):
        global battle_result
        battle_result = result
        B["phase"] = "done"
        for e in B["foes"]:
            e["flash"] = 0
        raise _Ctl("return", result)

    def battle_next():
        """Show the next queued message (applying its effect). Called by a timer and by taps."""
        while B["queue"]:
            text, fx = B["queue"].pop(0)
            if fx:
                fx()
            if text:
                B["msg"] = text
                return
            if B["phase"] != "resolve":
                return

    def battle_tick():
        for e in B["foes"]:
            if e["flash"]:
                e["flash"] -= 1
        if B.get("phase") == "resolve":
            battle_next()

    def foe_label():
        names = []
        for e in alive(B["foes"]):
            if e["name"] not in names:
                names.append(e["name"])
        return names

# ------------------------------------------------------------------ the battle screen
transform enemy_idle(d=0.0):
    yoffset 0
    ease 1.1 yoffset -8
    ease 1.1 yoffset 0
    repeat

transform battle_in:
    alpha 0.0 zoom 1.15
    ease 0.35 alpha 1.0 zoom 1.0

screen pswin(x, y, w, h, fill="#000814f0", line="#d8e4ff"):
    add Solid(line, xysize=(w + 6, h + 6)) pos (x - 3, y - 3)
    add Solid(fill, xysize=(w, h)) pos (x, y)

screen battle():
    modal True
    zorder 60
    $ resolving = B.get("phase") == "resolve"
    # backdrop
    if B.get("bg"):
        add B["bg"] xysize (1280, 720) at battle_in
    else:
        add Gradient(((0.0, "#050a1e"), (0.55, "#1b2a66"), (0.56, "#2a1a10"), (1.0, "#0c0604")), xysize=(1280, 720))
    # enemies, side by side, facing you
    $ foes = B.get("foes", [])
    $ shown = [e for e in foes if e["hp"] > 0]
    $ n = max(1, len(shown))
    for i, e in enumerate(shown):
        $ cx = int(640 + (i - (n - 1) / 2.0) * min(300, 1000 / n))
        if B.get("phase") == "target":
            imagebutton idle e["sprite"] xcenter cx yanchor 1.0 ypos 470 zoom e.get("zoom", 1.0) hover_tint "#ff8080" action Function(pick_target, e) at enemy_idle
        else:
            add e["sprite"] xcenter cx yanchor 1.0 ypos 470 zoom e.get("zoom", 1.0) tint ("#ff3030" if e["flash"] % 2 else None) at enemy_idle
    # message / enemy names (top)
    use pswin(40, 26, 1200, 64)
    text (B.get("msg") or "  ".join(foe_label())) pos (66, 44) size 24 font BATTLE_FONT color "#ffffff" xmaximum 1150
    # party status (bottom)
    $ pw = int((1200 - 20 * (len(party) - 1)) / max(1, len(party)))
    for i, m in enumerate(party):
        $ x = 40 + i * (pw + 20)
        $ on = B.get("phase") in ("command", "target") and B.get("actor") == i
        use pswin(x, 560, pw, 132, line=("#ffd34a" if on else "#d8e4ff"))
        if B.get("phase") == "ally":
            button:
                area (x, 560, pw, 132)
                hover_background Solid("#ffffff22")
                action Function(pick_target, m)
        text m["name"].upper() pos (x + 18, 574) size 22 font BATTLE_FONT color ("#ffd34a" if on else "#ffffff")
        text ("LV %d" % m["lvl"]) pos (x + pw - 100, 574) size 18 font BATTLE_FONT color "#9fb4ff"
        text ("HP %3d/%d" % (m["hp"], m["mhp"])) pos (x + 18, 614) size 20 font BATTLE_FONT color ("#ff6060" if m["hp"] * 4 < m["mhp"] else "#ffffff")
        add Solid("#33304a", xysize=(pw - 36, 6)) pos (x + 18, 642)
        add Solid("#4ade80", xysize=(max(0, int((pw - 36) * m["hp"] / max(1, m["mhp"]))), 6)) pos (x + 18, 642)
        if m["mmp"]:
            text ("MP %3d/%d" % (m["mp"], m["mmp"])) pos (x + 18, 656) size 20 font BATTLE_FONT color "#ffffff"
    # commands
    if B.get("phase") == "command" and not B.get("sub"):
        use pswin(40, 300, 230, 236)
        vbox:
            pos (62, 316) spacing 6
            for label, c in (("FIGHT", "fight"), ("MAGIC", "magic"), ("ITEM", "item"), ("TALK", "talk"), ("RUN", "run")):
                textbutton label action Function(cmd, c) text_font BATTLE_FONT text_size 26 text_color "#ffffff" text_hover_color "#ffd34a" padding (6, 4)
    elif B.get("sub") == "magic":
        use pswin(40, 300, 330, 236)
        vbox:
            pos (62, 316) spacing 6
            for k in cur_actor()["spells"]:
                textbutton ("%-6s %2d" % (SPELLS[k]["name"], SPELLS[k]["mp"])) action Function(pick_spell, k) text_font BATTLE_FONT text_size 24 text_color "#ffffff" text_hover_color "#ffd34a" padding (6, 4)
            textbutton "BACK" action Function(cancel) text_font BATTLE_FONT text_size 22 text_color "#9fb4ff" text_hover_color "#ffd34a" padding (6, 4)
    elif B.get("sub") == "item":
        use pswin(40, 300, 380, 236)
        vbox:
            pos (62, 316) spacing 6
            for k, cnt in inventory.items():
                if cnt > 0:
                    textbutton ("%-9s x%d" % (ITEMS[k]["name"], cnt)) action Function(pick_item, k) text_font BATTLE_FONT text_size 22 text_color "#ffffff" text_hover_color "#ffd34a" padding (6, 4)
            textbutton "BACK" action Function(cancel) text_font BATTLE_FONT text_size 22 text_color "#9fb4ff" text_hover_color "#ffd34a" padding (6, 4)
    elif B.get("phase") in ("target", "ally"):
        use pswin(40, 470, 520, 50)
        text ("Choose a target." if B["phase"] == "target" else "Choose who.") pos (60, 482) size 20 font BATTLE_FONT color "#ffffff"
        textbutton "BACK" action Function(cancel) pos (420, 476) text_font BATTLE_FONT text_size 20 text_color "#9fb4ff" text_hover_color "#ffd34a"
    if resolving:
        button:
            area (0, 0, 1280, 720)
            action Function(battle_next)
        timer 1.1 repeat True action Function(battle_next)
    timer 0.09 repeat True action Function(battle_tick)
    key "K_ESCAPE" action Function(cancel)

label battle:
    call screen battle
    $ B["foes"] = []
    return
