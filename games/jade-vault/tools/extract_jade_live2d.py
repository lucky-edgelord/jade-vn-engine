"""Write Jade's Live2D model (from Jade Vault, where it is embedded in the app) to assets/jade-live2d/.

    python3 tools/extract_jade_live2d.py ../../../jade-vault/app/base/pi-netrunner-mobile.html

The model is Jade Vault's own asset. Live2D's Cubism Core (the runtime) is not part of it: see config.live2d_core."""
import base64, gzip, json, os, re, sys

src = sys.argv[1]
out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "jade-live2d")
os.makedirs(out, exist_ok=True)
html = open(src, encoding="utf-8").read()


def block(i):
    m = re.search(r'<script type="[^"]*" id="%s">(.*?)</script>' % i, html, re.S)
    if not m:
        sys.exit(f"no #{i} in {src}")
    return m.group(1).strip()


model = json.loads(block("l2d-model"))
cdi = json.loads(block("l2d-cdi"))
params = {p["Id"] for p in cdi.get("Parameters", [])}
model["FileReferences"]["Textures"] = ["jade.webp"]
# blink and lip-sync: Jade Vault drives these itself; spell them out for other players
groups = {"EyeBlink": [p for p in ("ParamEyeLOpen", "ParamEyeROpen") if p in params], "LipSync": [p for p in ("ParamMouthOpenY",) if p in params]}
model["Groups"] = [{"Target": "Parameter", "Name": n, "Ids": ids} for n, ids in groups.items()]
for name, data in (("jadecat.model3.json", model), ("jadecat.physics3.json", json.loads(block("l2d-physics"))), ("jadecat.cdi3.json", cdi)):
    with open(os.path.join(out, name), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
with open(os.path.join(out, "jadecat.moc3"), "wb") as f:
    f.write(gzip.decompress(base64.b64decode(block("l2d-moc"))))
tex = block("l2d-tex")
assert tex.startswith("data:image/webp;base64,"), "expected a WebP texture"
with open(os.path.join(out, "jade.webp"), "wb") as f:
    f.write(base64.b64decode(tex.split(",", 1)[1]))
print(out, sorted(os.listdir(out)), groups)
