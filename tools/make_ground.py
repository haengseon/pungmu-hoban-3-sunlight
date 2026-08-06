"""Compose the 3D scene's ground texture.

VWorld's basemap has no road network inside the 풍무역세권 development yet, so the
georeferenced 호갱노노 capture (asset/map.png) is warped onto the VWorld tile.
The result is Web-Mercator aligned and shares its bounds with web/src/data/ground.json.
"""
import json
import math
import os

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB = os.path.join(ROOT, "web", "public")
META = json.load(open(os.path.join(ROOT, "web", "src", "data", "ground.json"),
                     encoding="utf-8"))

EARTH_C = 20037508.342789244


def merc(lon, lat):
    return (lon * EARTH_C / 180.0,
            math.log(math.tan((90.0 + lat) * math.pi / 360.0)) * EARTH_C / math.pi)


# ground raster frame
GC = merc(META["center"]["lon"], META["center"]["lat"])
GR = META["mercatorMetresPerPx"]
N = META["size"]

# map.png georeference (see tools/build_data.py)
FIT = dict(s=1.053002, theta=math.radians(-0.2957), tx=37.698, ty=-83.862)
VW_C = merc(126.7340, 37.6140)
VW_R = 156543.033928041 / (2 ** 17)
VW_N = 1000

base = Image.open(os.path.join(PUB, "ground_map.png")).convert("RGB").resize((N, N))
plan = Image.open(os.path.join(ROOT, "asset", "map.png")).convert("RGBA")
pa = np.array(plan).astype(np.float32)
PH, PW = pa.shape[:2]

gy, gx = np.mgrid[0:N, 0:N].astype(np.float64)
mx = GC[0] + (gx - N / 2 + 0.5) * GR
my = GC[1] - (gy - N / 2 + 0.5) * GR
vx = VW_N / 2 + (mx - VW_C[0]) / VW_R
vy = VW_N / 2 - (my - VW_C[1]) / VW_R

s, th, tx, ty = FIT["s"], FIT["theta"], FIT["tx"], FIT["ty"]
c, si = math.cos(th), math.sin(th)
dx, dy = vx - tx, vy - ty
u = (c * dx + si * dy) / s
v = (-si * dx + c * dy) / s

inside = (u >= 0) & (u <= PW - 1) & (v >= 0) & (v <= PH - 1)
warp = np.zeros((N, N, 3), np.float32)
for k in range(3):
    warp[..., k] = ndi.map_coordinates(pa[..., k], [v, u], order=1, mode="nearest")

# feather the seam so the capture blends into the surrounding basemap
alpha = ndi.gaussian_filter(inside.astype(np.float32), 6.0)
alpha = np.clip((alpha - 0.35) / 0.5, 0, 1) * inside

out = np.array(base).astype(np.float32)
out = out * (1 - alpha[..., None]) + warp * alpha[..., None]
img = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))
img.save(os.path.join(PUB, "ground_plan.png"), optimize=True)
print("ground_plan.png", img.size, round(os.path.getsize(os.path.join(PUB, "ground_plan.png")) / 1e6, 2), "MB")

# the aerial layer is only useful as a smaller JPEG
photo = Image.open(os.path.join(PUB, "ground_photo.png")).convert("RGB")
photo.save(os.path.join(PUB, "ground_photo.jpg"), quality=82, optimize=True)
os.remove(os.path.join(PUB, "ground_photo.png"))
print("ground_photo.jpg", round(os.path.getsize(os.path.join(PUB, "ground_photo.jpg")) / 1e6, 2), "MB")

META["basemaps"] = {"plan": "ground_plan.png", "map": "ground_map.png",
                    "photo": "ground_photo.jpg"}
json.dump(META, open(os.path.join(ROOT, "web", "src", "data", "ground.json"), "w",
                     encoding="utf-8"), ensure_ascii=False, indent=1)
