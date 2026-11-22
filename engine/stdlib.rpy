# vn-engine standard library: default screens, in the engine's own screen language.
# A game overrides any of these by defining a screen with the same name.

define gui.window_gradient = Gradient(((0.0, "#0000"), (0.45, "#000a"), (1.0, "#000d")), xysize=(1280, 250))

transform notify_appear:
    alpha 0.0
    linear 0.25 alpha 1.0

transform choice_in:
    alpha 0.0 xoffset -30
    ease 0.3 alpha 1.0 xoffset 0

screen say(who, what):
    zorder 10
    add gui.window_gradient pos (0, 470)
    if who is not None:
        text who pos (110, 520) size gui.name_size color gui.accent bold True outlines 2
    text what id "what" pos (110, 560) xmaximum 1060 size gui.text_size color gui.text_color outlines 2
    use quick_menu

screen choice(items):
    modal True
    zorder 20
    add Solid("#0006")
    vbox:
        xalign 0.5 yalign 0.42 spacing 16
        for i in items:
            textbutton i.caption action i.action xminimum 640 background Solid("#000a") hover_background Solid("#ff7eb6cc") text_size 28 xpadding 28 ypadding 12 text_color "#fff" text_hover_color "#fff" at choice_in

screen notify(message):
    zorder 100
    frame at notify_appear:
        pos (24, 24) background Solid("#000b") padding (18, 10)
        text message size 22 color "#fff"

screen quick_menu():
    zorder 50
    hbox:
        xalign 0.5 ypos 694 spacing 18
        textbutton "Back" action Rollback() text_size 18 padding (6, 2)
        textbutton "History" action ShowMenu("history") text_size 18 padding (6, 2)
        textbutton "Skip" action Skip() text_size 18 padding (6, 2)
        textbutton "Auto" action Auto() text_size 18 padding (6, 2)
        textbutton "Save" action ShowMenu("save") text_size 18 padding (6, 2)
        textbutton "Load" action ShowMenu("load") text_size 18 padding (6, 2)
        textbutton "Prefs" action ShowMenu("preferences") text_size 18 padding (6, 2)

screen main_menu():
    tag menu
    add Solid("#120a10")
    text config.name xalign 0.5 ypos 180 size 64 color gui.accent bold True outlines 3
    vbox:
        xalign 0.5 ypos 340 spacing 14
        textbutton "Start" action Start() text_size 34 xalign 0.5
        textbutton "Load" action ShowMenu("load") text_size 34 xalign 0.5
        textbutton "Preferences" action ShowMenu("preferences") text_size 34 xalign 0.5

screen game_menu_frame(title):
    add Solid("#0e070cee")
    text title pos (60, 40) size 44 color gui.accent bold True
    vbox:
        pos (60, 140) spacing 10
        textbutton "History" action ShowMenu("history") text_size 26
        textbutton "Save" action ShowMenu("save") text_size 26
        textbutton "Load" action ShowMenu("load") text_size 26
        textbutton "Preferences" action ShowMenu("preferences") text_size 26
        textbutton "Main Menu" action MainMenu() text_size 26
        textbutton "Return" action Return() text_size 26
    key "K_ESCAPE" action Return()

screen game_menu():
    tag menu
    modal True
    zorder 200
    use game_menu_frame("Menu")

screen history():
    tag menu
    modal True
    zorder 200
    use game_menu_frame("History")
    viewport:
        area (300, 120, 940, 560) draggable True yinitial 1.0
        child_size (940, max(560, 70 * len(_history)))
        vbox:
            spacing 12
            for h in _history:
                hbox:
                    spacing 16
                    text (h[0] or "") size 20 color gui.accent xsize 160
                    text h[1] size 20 color "#ddd" xmaximum 760

screen file_slots(title, save):
    tag menu
    modal True
    zorder 200
    use game_menu_frame(title)
    default page = 1
    $ meta = _slots()
    grid 3 2:
        pos (300, 120) spacing 18
        for i in range(6):
            $ slot = str((page - 1) * 6 + i + 1)
            $ m = meta.get(slot)
            button:
                xysize (300, 250) background Solid("#ffffff10") hover_background Solid("#ff7eb655")
                action (FileSave(slot) if save else FileLoad(slot))
                if m:
                    add Image(m["thumb"]) pos (54, 12)
                    text _slot_time(m["when"]) pos (12, 136) size 16 color "#fff"
                    text m["text"] pos (12, 162) size 15 color "#bbb" xmaximum 276
                else:
                    text "Empty slot" align (0.5, 0.5) size 20 color "#777"
    hbox:
        pos (300, 680) spacing 16
        for p in range(1, 6):
            textbutton str(p) action SetScreenVariable("page", p) text_size 22

screen save():
    tag menu
    modal True
    zorder 200
    use file_slots("Save", True)

screen load():
    tag menu
    modal True
    zorder 200
    use file_slots("Load", False)

screen preferences():
    tag menu
    modal True
    zorder 200
    use game_menu_frame("Preferences")
    vbox:
        pos (320, 140) spacing 14
        text "Text speed" size 24 color gui.accent
        hbox:
            spacing 12
            textbutton "Slow" action Preference("text speed", 25)
            textbutton "Normal" action Preference("text speed", 45)
            textbutton "Fast" action Preference("text speed", 90)
            textbutton "Instant" action Preference("text speed", 0)
        text "Auto-forward delay" size 24 color gui.accent
        hbox:
            spacing 12
            textbutton "Short" action Preference("auto-forward time", 0.8)
            textbutton "Normal" action Preference("auto-forward time", 1.5)
            textbutton "Long" action Preference("auto-forward time", 3.0)
        text "Volume" size 24 color gui.accent
        for label, key in (("Music", "music volume"), ("Sound", "sound volume"), ("Voice", "voice volume")):
            hbox:
                spacing 12
                text label size 20 xsize 90 color "#ccc"
                for v in (0.0, 0.25, 0.5, 0.75, 1.0):
                    textbutton ("%d%%" % int(v * 100)) action Preference(key, v) text_size 20
        text "Skip" size 24 color gui.accent
        hbox:
            spacing 12
            textbutton "Seen text only" action Preference("skip", False)
            textbutton "All text" action Preference("skip", True)
        text "Video effects" size 24 color gui.accent
        hbox:
            spacing 12
            textbutton "On" action Preference("effects", True)
            textbutton "Off" action Preference("effects", False)
