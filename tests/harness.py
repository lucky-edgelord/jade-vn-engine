"""Headless-Chrome harness for vn-engine builds (Playwright)."""
import functools, http.server, socketserver, threading, os
from playwright.sync_api import sync_playwright


class Game:
    def __init__(self, root, w=1280, h=720):
        class Q(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *a):
                pass
            extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map, **{'.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm'})
        H = functools.partial(Q, directory=root)
        self.srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.pw = sync_playwright().start()
        self.b = self.pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        self.pg = self.b.new_page(viewport={'width': w, 'height': h})
        self.errors, self.log = [], []
        self.pg.on('console', lambda m: (self.errors if m.type == 'error' and 'favicon' not in (m.location or {}).get('url', '') else self.log).append(m.text))
        self.pg.on('pageerror', lambda e: self.errors.append(str(e)))
        self.pg.goto(f'http://127.0.0.1:{self.srv.server_address[1]}/index.html')
        self.pg.wait_for_function('window.VN && (VN.state || VN.error)', timeout=60000)
        if self.ev('VN.error'):
            raise RuntimeError(self.ev('VN.error'))

    def ev(self, js):
        return self.pg.evaluate(js)

    def wait(self, ms):
        self.pg.wait_for_timeout(ms)

    def click(self, x, y, ms=120):
        self.pg.mouse.click(x, y); self.wait(ms)

    def key(self, k, ms=120):
        self.pg.keyboard.press(k); self.wait(ms)

    def wait_kind(self):
        return self.ev('VN.state.VM.wait && VN.state.VM.wait.kind')

    def label(self):
        return self.ev('VN.state.VM.label')

    def py(self, expr):
        return self.ev(f'VN.state.py({expr!r})')

    def say_text(self):
        return self.ev('VN.state.say() && VN.state.say().info.what')

    def shot(self, path):
        self.pg.screenshot(path=path)

    def close(self):
        self.b.close(); self.pw.stop(); self.srv.shutdown()
