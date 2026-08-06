"""Fetch a VWorld basemap mosaic to use as the 3D scene's ground texture.

VWorld's static-map endpoint caps a single request at 1024x1024, so the tile is
assembled from a 2x2 mosaic. The result is Web-Mercator aligned, which is what
the viewer assumes when it places the ground plane.

지금은 쓰이지 않는다 - 지면 텍스처는 카카오맵 타일로 대체됐다. 브이월드 정합
파라미터를 다시 뽑아야 할 때를 대비해 남겨둔다.
"""
import io
import json
import math
import os
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from env import get as env  # noqa: E402

KEY = env("VWORLD_KEY")
CENTER = (126.7345, 37.615625)
ZOOM = 18
TILE = 1024                       # px per request
GRID = 2                          # 2x2 -> 2048 px
EARTH_C = 20037508.342789244
R_MERC = 156543.033928041 / (2 ** ZOOM)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTDIR = os.path.join(ROOT, "web", "public")


def merc(lon, lat):
    return (lon * EARTH_C / 180.0,
            math.log(math.tan((90.0 + lat) * math.pi / 360.0)) * EARTH_C / math.pi)


def unmerc(x, y):
    return (x * 180.0 / EARTH_C,
            math.degrees(2 * math.atan(math.exp(y * math.pi / EARTH_C)) - math.pi / 2))


def fetch(basemap, lon, lat):
    q = urllib.parse.urlencode({
        "service": "image", "request": "getmap", "key": KEY, "format": "png",
        "basemap": basemap, "crs": "EPSG:4326",
        "center": f"{lon:.8f},{lat:.8f}", "zoom": ZOOM, "size": f"{TILE},{TILE}",
    })
    with urllib.request.urlopen("https://api.vworld.kr/req/image?" + q, timeout=60) as r:
        data = r.read()
    if data[:4] != b"\x89PNG":
        raise RuntimeError(data[:300].decode("utf-8", "replace"))
    return data


def main():
    from PIL import Image
    cx, cy = merc(*CENTER)
    size = TILE * GRID
    half = size / 2
    os.makedirs(OUTDIR, exist_ok=True)
    for basemap, name in (("GRAPHIC", "ground_map.png"), ("PHOTO", "ground_photo.png")):
        canvas = Image.new("RGB", (size, size))
        for gy in range(GRID):
            for gx in range(GRID):
                px = -half + TILE * (gx + 0.5)      # tile centre in px from centre
                py = -half + TILE * (gy + 0.5)
                lon, lat = unmerc(cx + px * R_MERC, cy - py * R_MERC)
                canvas.paste(Image.open(io.BytesIO(fetch(basemap, lon, lat))),
                             (gx * TILE, gy * TILE))
        canvas.save(os.path.join(OUTDIR, name), optimize=True)
        print(name, canvas.size)

    w = size * R_MERC                                # mercator metres across
    sw = unmerc(cx - w / 2, cy - w / 2)
    ne = unmerc(cx + w / 2, cy + w / 2)
    meta = dict(center=dict(lon=CENTER[0], lat=CENTER[1]), zoom=ZOOM, size=size,
                mercatorMetresPerPx=R_MERC,
                bounds=dict(west=round(sw[0], 8), south=round(sw[1], 8),
                            east=round(ne[0], 8), north=round(ne[1], 8)),
                basemaps=dict(map="ground_map.png", photo="ground_photo.png"),
                attribution="© VWorld (국토교통부 공간정보 오픈플랫폼)")
    out = os.path.join(ROOT, "web", "src", "data", "ground.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump(meta, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps(meta["bounds"], indent=1))


if __name__ == "__main__":
    main()
