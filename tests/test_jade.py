"""Jade's Vault smoke test: walk, lights, map, keypad, Live2D scene.  usage: test_jade.py build/jade-vault"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from harness import Game
OUT = '/tmp/jade_shots'; os.makedirs(OUT, exist_ok=True)
g = Game(sys.argv[1])
def py(e):
    r = g.py(e); return r.get('v') if isinstance(r, dict) else r
def shot(n): g.shot(f'{OUT}/{n}.png')
def talk(limit=40):
    for _ in range(limit):
        if g.wait_kind() != 'say': break
        g.key('Enter', 80)
try:
    g.wait(400); g.click(640, 362); g.wait(1200); talk(); g.wait(1500)
    print('explore', g.wait_kind(), py('pos')); shot('01_vault')
    g.pg.keyboard.down('ArrowUp'); g.wait(1400); g.pg.keyboard.up('ArrowUp'); g.wait(300); shot('02_walk_up'); print('after up', py('pos'))
    g.key('l', 400); shot('03_black'); g.key('l', 400); shot('04_lit'); g.key('l', 300)
    g.key('m', 500); shot('05_map'); g.key('m', 300)
    # walk to the Comms Desk via the API, then talk
    l = py('locus("comms")'); print('comms at', l['s'])
    g.ev(f"VN.state.exec('pos.update({{\"x\": {l['s'][0]//24}, \"y\": {l['s'][1]//24}, \"rev\": pos[\"rev\"] + 1}})')"); g.ev('VN.refresh()'); g.wait(600)
    g.key('Enter', 600); print('found', py('found'), g.wait_kind())
    for _ in range(6):
        if g.ev("VN.state.layers.master.some(x => x.tag === 'hiyori')"): break
        g.key('Enter', 400)
    g.wait(5000); shot('06_live2d'); g.pg.mouse.move(1100, 200); g.wait(1500); shot('07_live2d_look')
    talk(); g.wait(800); g.key('v', 600); shot('08_vhs')
finally:
    print('ERRORS', g.errors[:6]); g.close()
