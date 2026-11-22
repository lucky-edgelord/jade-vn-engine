#!/usr/bin/env python3
"""Generate the RPG demo's art procedurally (original, free to use): tileset, character sheet, monsters,
battle backdrops and a little house rendered as 360° panoramas + one flat photo for the tour."""
import os
import numpy as np
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets')
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(7)
T = 16


def noise_tile(base, var, seed, dots=None):
    r = np.random.default_rng(seed)
    a = np.zeros((T, T, 3), np.int16) + np.array(base)
    a += r.integers(-var, var + 1, (T, T, 1))
    if dots:
        for (c, n) in dots:
            for _ in range(n):
                x, y = r.integers(0, T, 2); a[y, x] = c
    return np.clip(a, 0, 255).astype(np.uint8)


# ---------------------------------------------------------------- tileset (8 columns)
tiles = []
grass = noise_tile((70, 140, 60), 10, 1)
tiles.append(grass)                                                        # 0 grass
tiles.append(noise_tile((70, 140, 60), 10, 2, [((240, 220, 90), 3), ((240, 120, 160), 2)]))   # 1 flowers
tiles.append(noise_tile((170, 140, 95), 12, 3))                            # 2 path
for k in range(2):                                                         # 3,4 water (animated)
    w = noise_tile((50, 100, 190), 6, 4 + k)
    for y in range(T):
        for x in range(T):
            if (x + y * 2 + k * 4) % 9 == 0: w[y, x] = (150, 200, 255)
    tiles.append(w)
tree = grass.copy(); im = Image.fromarray(tree); d = ImageDraw.Draw(im)
d.rectangle((7, 10, 8, 15), fill=(90, 60, 30)); d.ellipse((2, 1, 13, 11), fill=(30, 95, 40)); d.ellipse((4, 2, 9, 6), fill=(50, 130, 55))
tiles.append(np.array(im))                                                 # 5 tree
st = noise_tile((120, 120, 130), 8, 6)
for y in (0, 5, 10, 15): st[y, :] = (80, 80, 90)
for y0, xs in ((0, (4, 12)), (5, (0, 8)), (10, (4, 12))):
    for x in xs: st[y0:y0 + 5, x] = (80, 80, 90)
tiles.append(st)                                                           # 6 stone wall
wood = noise_tile((150, 100, 60), 8, 7)
for y in (3, 7, 11, 15): wood[y, :] = (110, 70, 40)
tiles.append(wood)                                                         # 7 wood floor
im = Image.fromarray(noise_tile((200, 180, 150), 6, 8)); d = ImageDraw.Draw(im)
d.rectangle((3, 2, 12, 15), fill=(110, 60, 30)); d.point((10, 9), fill=(240, 200, 80))
tiles.append(np.array(im))                                                 # 8 door
roof = noise_tile((170, 60, 50), 10, 9)
for y in range(0, T, 4): roof[y, :] = (120, 40, 35)
tiles.append(roof)                                                         # 9 roof
tiles.append(noise_tile((220, 200, 140), 8, 10))                           # 10 sand
tiles.append(noise_tile((60, 55, 65), 8, 11, [((80, 75, 85), 10)]))         # 11 cave floor
cw = noise_tile((40, 35, 45), 10, 12)
for _ in range(6):
    x, y = rng.integers(0, 14, 2); cw[y:y + 2, x:x + 3] = (70, 65, 75)
tiles.append(cw)                                                           # 12 cave wall
im = Image.fromarray(cw.copy()); d = ImageDraw.Draw(im)
d.rectangle((7, 6, 8, 14), fill=(90, 60, 30)); d.ellipse((5, 1, 10, 7), fill=(255, 170, 40)); d.ellipse((6, 2, 9, 5), fill=(255, 240, 150))
tiles.append(np.array(im))                                                 # 13 torch
im = Image.fromarray(noise_tile((70, 140, 60), 10, 14)); d = ImageDraw.Draw(im)
d.polygon([(1, 15), (8, 3), (15, 15)], fill=(70, 65, 75)); d.polygon([(5, 15), (8, 8), (11, 15)], fill=(10, 8, 12))
tiles.append(np.array(im))                                                 # 14 cave entrance
im = Image.fromarray(grass.copy()); d = ImageDraw.Draw(im)
d.rectangle((7, 8, 8, 15), fill=(110, 70, 40)); d.rectangle((2, 3, 13, 9), fill=(180, 130, 80)); d.line((4, 6, 11, 6), fill=(90, 60, 30))
tiles.append(np.array(im))                                                 # 15 sign
tg = noise_tile((50, 120, 45), 10, 16)
for x in range(0, T, 3):
    tg[4 + (x % 5):, x] = (35, 90, 35); tg[2 + (x % 4), x] = (90, 170, 70)
tiles.append(tg)                                                           # 16 tall grass
hw = noise_tile((230, 220, 200), 5, 17)
hw[:, 0] = hw[:, 15] = (170, 160, 140)
im = Image.fromarray(hw); d = ImageDraw.Draw(im); d.rectangle((4, 4, 11, 10), fill=(120, 170, 220)); d.line((8, 4, 8, 10), fill=(80, 60, 40)); d.line((4, 7, 11, 7), fill=(80, 60, 40))
tiles.append(np.array(im))                                                 # 17 house wall with window
im = Image.fromarray(noise_tile((60, 55, 65), 8, 18)); d = ImageDraw.Draw(im)
d.rectangle((2, 5, 13, 14), fill=(120, 80, 40)); d.rectangle((2, 5, 13, 8), fill=(150, 100, 50)); d.rectangle((7, 8, 8, 10), fill=(240, 200, 80))
tiles.append(np.array(im))                                                 # 18 chest
im = Image.fromarray(noise_tile((60, 55, 65), 8, 19)); d = ImageDraw.Draw(im)
for i in range(4): d.rectangle((2 + i, 3 + i * 3, 13 - i, 4 + i * 3), fill=(150 - i * 25, 150 - i * 25, 160 - i * 25))
tiles.append(np.array(im))                                                 # 19 stairs up
im = Image.fromarray(noise_tile((120, 120, 130), 8, 20)); d = ImageDraw.Draw(im)
d.ellipse((2, 2, 13, 13), fill=(70, 70, 80)); d.ellipse((4, 4, 11, 11), fill=(40, 70, 150))
tiles.append(np.array(im))                                                 # 20 well
sheet = Image.new('RGB', (8 * T, ((len(tiles) + 7) // 8) * T))
for i, t in enumerate(tiles):
    sheet.paste(Image.fromarray(t), ((i % 8) * T, (i // 8) * T))
sheet.save(os.path.join(OUT, 'tiles.png'))

# ---------------------------------------------------------------- characters: 3 frames x 4 directions, several outfits
def person(d, ox, oy, face, frame, shirt, hair, skin=(250, 210, 170)):
    leg = [0, 1, 0][frame] if frame != 1 else 0
    step = (-1, 0, 1)[frame]
    d.rectangle((ox + 5, oy + 12, ox + 6, oy + 15 + (step < 0)), fill=(50, 50, 80))
    d.rectangle((ox + 9, oy + 12, ox + 10, oy + 15 + (step > 0)), fill=(50, 50, 80))
    d.rectangle((ox + 4, oy + 7, ox + 11, oy + 12), fill=shirt)
    d.rectangle((ox + 4, oy + 1, ox + 11, oy + 7), fill=skin)
    if face == 'up':
        d.rectangle((ox + 4, oy + 1, ox + 11, oy + 6), fill=hair)
    else:
        d.rectangle((ox + 4, oy + 1, ox + 11, oy + 3), fill=hair)
        if face == 'down':
            d.point((ox + 6, oy + 5), fill=(30, 30, 30)); d.point((ox + 9, oy + 5), fill=(30, 30, 30))
        elif face == 'left':
            d.rectangle((ox + 10, oy + 1, ox + 11, oy + 6), fill=hair); d.point((ox + 5, oy + 5), fill=(30, 30, 30))
        else:
            d.rectangle((ox + 4, oy + 1, ox + 5, oy + 6), fill=hair); d.point((ox + 10, oy + 5), fill=(30, 30, 30))
    arm = (step * 1)
    d.rectangle((ox + 3, oy + 8 + max(0, arm), ox + 3, oy + 11 + max(0, arm)), fill=skin)
    d.rectangle((ox + 12, oy + 8 + max(0, -arm), ox + 12, oy + 11 + max(0, -arm)), fill=skin)


outfits = [((200, 60, 70), (60, 40, 30)), ((60, 110, 200), (230, 200, 90)), ((90, 160, 90), (120, 120, 120)), ((150, 80, 170), (30, 30, 40))]
cs = Image.new('RGBA', (3 * T, 4 * T * len(outfits)), (0, 0, 0, 0)); d = ImageDraw.Draw(cs)
for o, (shirt, hair) in enumerate(outfits):
    for r, face in enumerate(('down', 'left', 'right', 'up')):
        for f in range(3):
            person(d, f * T, (o * 4 + r) * T, face, f, shirt, hair)
cs.save(os.path.join(OUT, 'people.png'))

# ---------------------------------------------------------------- monsters (pixel art scaled up)
def monster(name, draw, size=32, scale=7):
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0)); draw(ImageDraw.Draw(im))
    im.resize((size * scale, size * scale), Image.NEAREST).save(os.path.join(OUT, name + '.png'))


def slime(d):
    d.ellipse((4, 10, 28, 30), fill=(70, 150, 230)); d.ellipse((8, 12, 18, 18), fill=(150, 210, 255))
    d.ellipse((10, 18, 14, 22), fill=(255, 255, 255)); d.ellipse((18, 18, 22, 22), fill=(255, 255, 255))
    d.point((12, 20), fill=(0, 0, 0)); d.point((20, 20), fill=(0, 0, 0)); d.line((13, 25, 19, 25), fill=(20, 60, 110))


def bat(d):
    d.polygon([(16, 14), (2, 6), (6, 14), (1, 18), (10, 18), (16, 22)], fill=(90, 40, 110))
    d.polygon([(16, 14), (30, 6), (26, 14), (31, 18), (22, 18), (16, 22)], fill=(90, 40, 110))
    d.ellipse((11, 11, 21, 23), fill=(120, 60, 140)); d.point((14, 15), fill=(255, 60, 60)); d.point((18, 15), fill=(255, 60, 60))
    d.polygon([(12, 11), (13, 7), (15, 11)], fill=(120, 60, 140)); d.polygon([(17, 11), (19, 7), (20, 11)], fill=(120, 60, 140))


def scorpion(d):
    d.ellipse((6, 18, 26, 28), fill=(200, 120, 40)); d.ellipse((2, 17, 9, 23), fill=(220, 140, 50)); d.ellipse((23, 17, 30, 23), fill=(220, 140, 50))
    for i in range(4): d.ellipse((20 - i * 2, 14 - i * 3, 25 - i * 2, 19 - i * 3), fill=(200, 120, 40))
    d.polygon([(12, 4), (16, 1), (15, 7)], fill=(240, 220, 200))
    for x in (9, 13, 19, 23): d.line((x, 27, x - 2, 31), fill=(150, 80, 20))
    d.point((13, 21), fill=(0, 0, 0)); d.point((19, 21), fill=(0, 0, 0))


def ghost(d):
    d.ellipse((6, 3, 26, 22), fill=(220, 230, 240)); d.rectangle((6, 12, 26, 26), fill=(220, 230, 240))
    for x in range(6, 26, 5): d.polygon([(x, 26), (x + 2, 30), (x + 5, 26)], fill=(220, 230, 240))
    d.ellipse((10, 9, 15, 15), fill=(20, 0, 30)); d.ellipse((18, 9, 23, 15), fill=(20, 0, 30)); d.ellipse((14, 17, 19, 22), fill=(20, 0, 30))


monster('slime', slime); monster('bat', bat); monster('scorpion', scorpion); monster('ghost', ghost)


# ---------------------------------------------------------------- battle backdrops (first person, PS style)
def backdrop(name, sky, ground, horizon=0.55, features=None):
    W, H = 1280, 720
    a = np.zeros((H, W, 3), np.float32); hy = int(H * horizon)
    for y in range(H):
        if y < hy: a[y] = np.array(sky[0]) + (np.array(sky[1]) - np.array(sky[0])) * (y / hy)
        else:
            k = (y - hy) / (H - hy); a[y] = np.array(ground[0]) + (np.array(ground[1]) - np.array(ground[0])) * k
            if int((y - hy) ** 1.35) % 14 < 2: a[y] *= 0.85
    im = Image.fromarray(a.clip(0, 255).astype(np.uint8)); d = ImageDraw.Draw(im)
    if features: features(d, W, H, hy)
    im.save(os.path.join(OUT, name + '.jpg'), quality=88)


def field(d, W, H, hy):
    for i in range(9):
        x = i * 160 + rng.integers(-30, 30); h = rng.integers(60, 120)
        d.polygon([(x - 90, hy), (x, hy - h), (x + 90, hy)], fill=(60, 110, 140))
    for i in range(14):
        x = rng.integers(0, W); d.ellipse((x - 40, hy - 30, x + 40, hy + 10), fill=(40, 100, 50))


def cave(d, W, H, hy):
    for i in range(18):
        x = rng.integers(0, W); w = rng.integers(20, 60); h = rng.integers(60, 200)
        d.polygon([(x - w, 0), (x, h), (x + w, 0)], fill=(35, 30, 45))
    for i in range(10):
        x = rng.integers(0, W); w = rng.integers(20, 50); h = rng.integers(40, 120)
        d.polygon([(x - w, hy + 40), (x, hy + 40 - h), (x + w, hy + 40)], fill=(45, 40, 55))


backdrop('bg_field', ((90, 150, 230), (200, 230, 250)), ((80, 150, 70), (40, 100, 40)), features=field)
backdrop('bg_cave', ((10, 8, 18), (40, 30, 50)), ((50, 45, 60), (20, 18, 25)), features=cave)


# ---------------------------------------------------------------- house tour: raycast a box room into equirectangular panoramas
def room_pano(name, size, wall, floor, ceil, doors, windows, items=(), W=2048, H=1024, flat=None):
    """Box room (width x depth x height metres), camera 1.5 m high at the centre. doors/windows: (wall, centre_u, w, h, bottom, colour)
    where wall is 'n','e','s','w' and centre_u runs -0.5..0.5 along the wall. Returns an RGB image."""
    rw, rd, rh = size; cam_h = 1.5
    if flat:
        fov, yaw = flat; f = (W / 2) / np.tan(np.radians(fov) / 2)
        xs, ys = np.meshgrid(np.arange(W) - W / 2 + 0.5, np.arange(H) - H / 2 + 0.5)
        dx, dy, dz = xs / f, -ys / f, np.ones_like(xs)
        c, s = np.cos(np.radians(yaw)), np.sin(np.radians(yaw)); dx, dz = dx * c + dz * s, -dx * s + dz * c
    else:
        lon = (np.arange(W) + 0.5) / W * 2 * np.pi - np.pi; lat = np.pi / 2 - (np.arange(H) + 0.5) / H * np.pi
        lon, lat = np.meshgrid(lon, lat)
        dx, dy, dz = np.cos(lat) * np.sin(lon), np.sin(lat), np.cos(lat) * np.cos(lon)
    big = 1e9
    tx = np.where(dx > 0, (rw / 2) / np.maximum(dx, 1e-9), np.where(dx < 0, (-rw / 2) / np.minimum(dx, -1e-9), big))
    tz = np.where(dz > 0, (rd / 2) / np.maximum(dz, 1e-9), np.where(dz < 0, (-rd / 2) / np.minimum(dz, -1e-9), big))
    ty = np.where(dy > 0, (rh - cam_h) / np.maximum(dy, 1e-9), np.where(dy < 0, (-cam_h) / np.minimum(dy, -1e-9), big))
    t = np.minimum(np.minimum(tx, tz), ty)
    px, py, pz = dx * t, dy * t + cam_h, dz * t
    img = np.zeros(t.shape + (3,), np.float32)
    isy, isx = ty <= np.minimum(tx, tz), (tx < tz) & (tx < ty)
    isz = ~isy & ~isx
    # floor / ceiling
    fl = isy & (dy < 0); ce = isy & (dy > 0)
    plank = ((np.floor(px * 4) + np.floor(pz * 0.8 + np.floor(px * 4) * 0.37)) % 2)
    img[fl] = (np.array(floor) * (0.88 + 0.12 * plank[..., None]))[fl]
    img[ce] = ceil
    # walls: u along wall (-0.5..0.5), v height
    wallname = np.where(isx, np.where(dx > 0, 1, 3), np.where(dz > 0, 0, 2))   # 0 n(+z) 1 e(+x) 2 s(-z) 3 w(-x)
    u = np.where(isx, np.where(dx > 0, pz, -pz) / rd, np.where(dz > 0, -px, px) / rw)
    wl = ~isy
    stripe = 0.94 + 0.06 * ((np.floor((u + 0.5) * 40)) % 2)
    img[wl] = (np.array(wall) * stripe[..., None])[wl]
    img[wl & (py < 0.12)] = np.array(wall) * 0.55                               # skirting board
    idx = {'n': 0, 'e': 1, 's': 2, 'w': 3}
    for (wn, cu, w, h, b, col) in list(doors) + list(windows):
        L = rw if idx[wn] in (0, 2) else rd
        m = wl & (wallname == idx[wn]) & (np.abs(u - cu) < w / L / 2) & (py > b) & (py < b + h)
        img[m] = col
        frame = wl & (wallname == idx[wn]) & (np.abs(u - cu) < w / L / 2 + 0.012) & (py > b - 0.05) & (py < b + h + 0.05) & ~m
        img[frame] = (240, 235, 225)
    for (wn, cu, w, h, b, col) in items:
        L = rw if idx[wn] in (0, 2) else rd
        m = wl & (wallname == idx[wn]) & (np.abs(u - cu) < w / L / 2) & (py > b) & (py < b + h)
        img[m] = col
    shade = np.clip(1.15 - t * 0.09, 0.55, 1.1)[..., None]
    img = img * shade
    return Image.fromarray(img.clip(0, 255).astype(np.uint8))


SKY = (170, 210, 245)
hall = dict(size=(4.0, 6.0, 2.6), wall=(222, 208, 186), floor=(150, 105, 70), ceil=(240, 238, 232),
            doors=[('n', 0.0, 0.9, 2.05, 0, (120, 75, 45)), ('e', 0.25, 0.9, 2.05, 0, (60, 45, 40)), ('s', 0.0, 1.0, 2.1, 0, (110, 70, 40))],
            windows=[('w', 0.0, 1.2, 1.1, 1.0, SKY)], items=[('w', 0.35, 0.6, 0.8, 1.2, (180, 60, 70))])
kitchen = dict(size=(5.0, 4.0, 2.6), wall=(210, 230, 215), floor=(200, 200, 205), ceil=(245, 245, 245),
               doors=[('s', 0.0, 0.9, 2.05, 0, (60, 45, 40))], windows=[('n', -0.2, 1.4, 1.0, 1.1, SKY), ('e', 0.0, 1.0, 1.0, 1.1, SKY)],
               items=[('n', 0.25, 1.6, 0.9, 0.0, (240, 240, 245)), ('w', 0.0, 2.4, 0.9, 0.0, (140, 100, 70)), ('w', 0.0, 2.4, 0.04, 0.9, (60, 60, 65))])
study = dict(size=(3.5, 3.5, 2.5), wall=(90, 70, 90), floor=(90, 60, 45), ceil=(200, 195, 190),
             doors=[('w', 0.0, 0.9, 2.05, 0, (60, 45, 40))], windows=[('n', 0.0, 0.9, 0.9, 1.2, (40, 50, 90))],
             items=[('e', 0.0, 1.6, 1.9, 0.0, (110, 70, 45)), ('e', 0.0, 1.5, 0.05, 0.6, (70, 45, 30)), ('e', 0.0, 1.5, 0.05, 1.2, (70, 45, 30)),
                    ('s', -0.15, 0.5, 0.35, 1.3, (230, 220, 180))])
for name, spec in (('hall', hall), ('kitchen', kitchen), ('study', study)):
    room_pano(name, **spec).save(os.path.join(OUT, f'tour_{name}.jpg'), quality=85)
room_pano('porch', **dict(hall, flat=(70, 180)), W=1600, H=1000).save(os.path.join(OUT, 'tour_hall_flat.jpg'), quality=85)
print('art ->', OUT, sorted(os.listdir(OUT)))
