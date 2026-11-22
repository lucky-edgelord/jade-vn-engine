define e = Character("Eileen", who_color="#c8ffc8")
default points = 0
image bg dusk = Solid("#334")
transform slidein:
    xalign 1.5 yalign 1.0
    ease 0.6 xalign 0.5
label start:
    scene bg dusk with fade
    e "Hello! You have [points] points.{w=0.3} Nice."
    $ points += 5
    menu:
        e "Pick one."
        "More points":
            $ points += 10
            jump done
        "Fewer" if points > 100:
            pass
    label done:
    e "Now [points]."
    return
