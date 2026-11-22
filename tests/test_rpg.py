"""Smoke-test the RPG demo: walking, map mode, battle, tour, minigame.  usage: test_rpg.py build/rpg-demo"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from harness import Game
OUT = '/tmp/rpg_shots'; os.makedirs(OUT, exist_ok=True)
g = Game(sys.argv[1])
def py(e):
    r = g.py(e); return r.get('v') if isinstance(r, dict) else r
def ex(c): g.ev(f'VN.state.exec({c!r})'); g.ev('VN.refresh()'); g.wait(80)
def shot(n): g.shot(f'{OUT}/{n}.png')
def talk_through(limit=60):
    for _ in range(limit):
        if g.wait_kind() != 'say': break
        g.key('Enter', 60)
try:
    g.wait(400); g.click(640, 362); g.wait(1500); talk_through(); g.wait(600)
    print('explore', g.wait_kind(), g.label(), py('pos')); shot('01_world')
    for _ in range(3): g.key('ArrowRight', 260)
    g.pg.keyboard.down('ArrowDown'); g.wait(700); g.pg.keyboard.up('ArrowDown'); g.wait(400)
    print('walked', py('pos'), py('steps')); shot('02_walked')
    g.key('m', 400); shot('03_map'); g.key('m', 300)
    # tap-to-walk: tap a tile a few tiles away
    g.click(640 + 48 * 3, 360, 1600); print('tapped', py('pos'))
    # battle
    ex('start_battle(["slime", "scorpion"], bg="bg_field.jpg")'); g.ev("VN.state.exec('renpy.jump(\"battle\")')"); g.wait(900); shot('04_battle')
    for turn in range(20):
        ph = py('B.get("phase")')
        if ph == 'command':
            g.click(110, 336, 250)
            if py('B.get("phase")') == 'target': g.click(560, 380, 250)
        elif ph == 'resolve':
            g.click(640, 300, 150)
        elif ph in ('target', 'ally'):
            g.key('Escape', 150)
        if turn == 1: shot('05_battle_turn')
        if g.label() != 'battle': break
    print('battle', py('battle_result'), g.label(), py('[(m["name"], m["hp"], m["xp"]) for m in party]'), py('gold'))
    g.wait(500); talk_through()
    # cave with lighting
    ex('warp("cave", 2, 2)'); g.ev("VN.state.exec('renpy.jump(\"explore\")')"); g.wait(1200); shot('06_cave')
    # house tour
    g.ev("VN.state.exec('renpy.jump(\"house\")')"); g.wait(1500); shot('07_tour_entry')
    g.click(640, 655, 1800); print('tour', py('tour_pos')); shot('08_tour_hall')
    g.pg.mouse.move(800, 360); g.pg.mouse.down(); g.pg.mouse.move(500, 360, steps=8); g.pg.mouse.up(); g.wait(500); shot('09_tour_turned')
    # minigame
    ex('mg_setup("keypad", code="1987")'); g.ev("VN.state.exec('renpy.jump(\"thing_chest\")')"); g.wait(400); talk_through(3); g.wait(300)
    for d in "1987": g.key(d, 120)
    shot('10_keypad'); g.key('Enter', 1500); talk_through(); print('chest', py('chest_open'), py('gold'))
finally:
    print('ERRORS', g.errors[:6]); g.close()
