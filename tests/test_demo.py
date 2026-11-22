import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from harness import Game
g = Game(sys.argv[1])
try:
    g.wait(500); g.shot('/tmp/demo_menu.png')
    print('screens', g.ev('VN.state.screens().map(s=>s.name)'))
    g.click(640, 362)  # Start
    g.wait(1500)
    print('wait', g.wait_kind(), '|', g.say_text())
    g.shot('/tmp/demo_say.png')
    g.click(640, 300); g.click(640, 300)
    print('wait', g.wait_kind(), g.py('points'))
    g.wait(300); g.shot('/tmp/demo_menu2.png')
    print('trees', list(g.ev('VN.state.trees()').keys()))
finally:
    print('errors', g.errors[:5]); g.close()
