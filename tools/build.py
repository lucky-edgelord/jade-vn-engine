#!/usr/bin/env python3
"""Package a vn-engine game as a folder and a .xdc (webxdc zip).

    python3 tools/build.py games/demo            -> build/demo/ + dist/demo.xdc
    python3 tools/build.py games/demo --serve    -> also serve build/demo on http://127.0.0.1:8000

A game folder holds *.rpy scripts, an optional game.toml (name, icon) and an optional assets/ folder
whose files are copied as-is (atlas.json + art*.avif, audio.json + audio.bin, images, fonts, ...).
"""
import os, sys, shutil, zipfile, json, re, subprocess
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import vnc

INDEX = """<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>{title}</title>
<style>
html,body{{margin:0;height:100%;background:#000;overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none}}
canvas{{display:block;width:100vw;height:100vh;object-fit:contain}}
</style>
<canvas id="screen" width="1280" height="720"></canvas>
<script type="module">
import '{engine}vn.js';
VN.boot({{ canvas: document.getElementById('screen') }});
</script>
"""


def toml(path):
    d = {}
    if os.path.exists(path):
        for line in open(path, encoding='utf-8'):
            m = re.match(r'\s*(\w+)\s*=\s*"(.*)"\s*$', line)
            if m:
                d[m.group(1)] = m.group(2)
    return d


CDN = 'https://cdn.jsdelivr.net/gh/lucky-edgelord/vn-engine@{ref}/engine/'


def build(game, outdir=None, xdc=None, cdn=None):
    name = os.path.basename(os.path.normpath(game))
    meta = toml(os.path.join(game, 'game.toml'))
    outdir = outdir or os.path.join(ROOT, 'build', name)
    xdc = xdc or os.path.join(ROOT, 'dist', name + '.xdc')
    if os.path.exists(outdir):
        shutil.rmtree(outdir)
    os.makedirs(outdir)
    scripts = sorted(os.path.join(dp, f) for dp, _, fs in os.walk(game) for f in fs if f.endswith('.rpy'))
    g = vnc.compile_files([os.path.join(ROOT, 'engine', 'stdlib.rpy')] + scripts)
    with open(os.path.join(outdir, 'game.json'), 'w', encoding='utf-8') as f:
        json.dump(g, f, ensure_ascii=False, separators=(',', ':'))
    if not cdn:
        for f in os.listdir(os.path.join(ROOT, 'engine')):
            if f.endswith(('.js', '.py')):
                shutil.copy(os.path.join(ROOT, 'engine', f), outdir)
        os.makedirs(os.path.join(outdir, 'vendor'))
        for f in ('micropython.mjs', 'micropython.wasm'):
            shutil.copy(os.path.join(ROOT, 'engine', 'vendor', f), os.path.join(outdir, 'vendor'))
    with open(os.path.join(outdir, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(INDEX.format(title=meta.get('name', name), engine=cdn or './'))
    with open(os.path.join(outdir, 'manifest.toml'), 'w', encoding='utf-8') as f:
        f.write(f'name = "{meta.get("name", name)}"\n')
        if meta.get('source_code_url'):
            f.write(f'source_code_url = "{meta["source_code_url"]}"\n')
    assets = os.path.join(game, meta.get('assets', 'assets'))
    if os.path.isdir(assets):
        for dp, _, fs in os.walk(assets):
            for f in fs:
                src = os.path.join(dp, f)
                dst = os.path.join(outdir, os.path.relpath(src, assets))
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy(src, dst)
    icon = os.path.join(game, meta.get('icon', 'icon.png'))
    if os.path.exists(icon):
        shutil.copy(icon, os.path.join(outdir, 'icon.png'))
    os.makedirs(os.path.dirname(xdc), exist_ok=True)
    stored = ('.avif', '.webp', '.png', '.jpg', '.bin', '.ogg', '.opus', '.mp3', '.woff2')
    with zipfile.ZipFile(xdc, 'w') as z:
        for dp, _, fs in os.walk(outdir):
            for f in sorted(fs):
                p = os.path.join(dp, f)
                arc = os.path.relpath(p, outdir)
                zi = zipfile.ZipInfo(arc, (2026, 1, 1, 0, 0, 0))
                comp = zipfile.ZIP_STORED if f.endswith(stored) else zipfile.ZIP_DEFLATED
                with open(p, 'rb') as fh:
                    z.writestr(zi, fh.read(), compress_type=comp, compresslevel=9)
    print(f'{name}: {len(g["code"])} ops, {len(g["labels"])} labels -> {xdc} ({os.path.getsize(xdc) / 1e6:.2f} MB)')
    return outdir, xdc


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(2)
    try:
        ref = next((a.split('=', 1)[1] for a in sys.argv if a.startswith('--cdn=')), 'main' if '--cdn' in sys.argv else None)
        out, x = build(sys.argv[1], cdn=CDN.format(ref=ref) if ref else None)
    except vnc.CompileError as e:
        print('error:', e, file=sys.stderr); sys.exit(1)
    if '--serve' in sys.argv:
        subprocess.run([sys.executable, '-m', 'http.server', '8000', '-d', out])
