"""Regenerate the screenshots and demo GIFs in docs/img from the sample games.
usage: python3 tools/docshots.py            (needs build/<game> from tools/build.py, Playwright, ffmpeg)"""
import os, sys, subprocess, tempfile, shutil
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tests'))
from harness import Game
OUT = os.path.join(ROOT, 'docs', 'img'); os.makedirs(OUT, exist_ok=True)

def gif(g, name, action, frames=24, every=90, width=560):
    """record `frames` screenshots while `action()` runs in steps, then encode a looping GIF"""
    d = tempfile.mkdtemp()
    for i in range(frames):
        action(i); g.wait(every); g.shot(f'{d}/f{i:03d}.png')
    fps = round(1000 / every)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(fps), '-i', f'{d}/f%03d.png',
                    '-vf', f'scale={width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
                    '-loop', '0', f'{OUT}/{name}.gif'], check=True)
    shutil.rmtree(d); print('gif', name)

def shot(g, name): g.shot(f'{OUT}/{name}.png'); print('png', name)

def talk(g, n=60):
    for _ in range(n):
        if g.wait_kind() != 'say': break
        g.key('Enter', 60)

def rpg():
    g = Game(os.path.join(ROOT, 'build/rpg-demo'))
    py = lambda e: (lambda r: r.get('v') if isinstance(r, dict) else r)(g.py(e))
    ex = lambda c: (g.ev(f'VN.state.exec({c!r})'), g.ev('VN.refresh()'), g.wait(80))
    try:
        g.wait(400); g.click(640, 362); g.wait(1500); talk(g); g.wait(600)
        shot(g, 'rpg-world')
        keys = ['ArrowRight'] * 3 + ['ArrowDown'] * 5 + ['ArrowRight'] * 4
        gif(g, 'rpg-walk', lambda i: g.pg.keyboard.press(keys[i % len(keys)]), frames=12, every=170)
        g.key('m', 500); shot(g, 'rpg-map'); g.key('m', 300)
        ex('start_battle(["slime", "scorpion"], bg="bg_field.jpg")'); g.ev("VN.state.exec('renpy.jump(\"battle\")')"); g.wait(900)
        shot(g, 'rpg-battle')
        def fight(i):
            ph = py('B.get("phase")')
            if ph == 'command':
                g.click(110, 336, 150)
                if py('B.get("phase")') == 'target': g.click(560, 380, 150)
            elif ph == 'resolve': g.click(640, 300, 80)
        gif(g, 'rpg-battle', fight, frames=26, every=260)
        g.wait(500); talk(g)
        ex('warp("cave", 2, 2)'); g.ev("VN.state.exec('renpy.jump(\"explore\")')"); g.wait(1200); shot(g, 'rpg-cave-light')
        g.ev("VN.state.exec('renpy.jump(\"house\")')"); g.wait(1500); shot(g, 'tour-entry')
        g.click(640, 655, 1800); shot(g, 'tour-hall')
        def turn(i):
            if i == 0: g.pg.mouse.move(850, 360); g.pg.mouse.down()
            else: g.pg.mouse.move(850 - i * 30, 360)
        gif(g, 'tour-look', turn, frames=18, every=90)
        g.pg.mouse.up()
        ex('mg_setup("keypad", code="1987")'); g.ev("VN.state.exec('renpy.jump(\"thing_chest\")')"); g.wait(400); talk(g, 3); g.wait(300)
        for d in "19": g.key(d, 120)
        shot(g, 'minigame-keypad')
    finally:
        print('rpg errors', g.errors[:4]); g.close()

def demo():
    g = Game(os.path.join(ROOT, 'build/demo'))
    try:
        g.wait(500); shot(g, 'demo-menu'); g.click(640, 362); g.wait(900); shot(g, 'demo-say')
    finally:
        print('demo errors', g.errors[:4]); g.close()

def jade():
    g = Game(os.path.join(ROOT, 'build/jade-vault'))
    py = lambda e: (lambda r: r.get('v') if isinstance(r, dict) else r)(g.py(e))
    try:
        g.wait(400); g.click(640, 362); g.wait(1500); talk(g); g.wait(600); shot(g, 'vault-explore')
        def up(i): g.pg.keyboard.down('ArrowUp') if i == 0 else None
        gif(g, 'vault-walk', up, frames=14, every=110); g.pg.keyboard.up('ArrowUp')
        seq = ['l', None, None, None, 'l', None, None, None]
        gif(g, 'vault-lights', lambda i: g.key(seq[i % 8], 10) if seq[i % 8] else None, frames=16, every=250)
        g.key('m', 500); shot(g, 'vault-map'); g.key('m', 300)
    finally:
        print('jade errors', g.errors[:4]); g.close()

if __name__ == '__main__':
    for f in (demo, rpg, jade): f()
