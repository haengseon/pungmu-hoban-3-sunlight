"""Build web/src/data/buildings.json for the 풍무 호반써밋 3차 일조 분석 웹앱.

Pipeline
--------
1. `asset/map.png` (호갱노노 캡처) 를 VWorld 정적지도와 정합해서 지오레퍼런싱한다.
   - 두 지도 모두 Web Mercator 정북 기준이라 (scale, rotation, translation) 4-파라미터
     상사변환으로 충분하다. 파라미터는 tools/georef.py 에서 IoU 최적화로 구했다.
2. 호반써밋 풍무 III(3차, 분석 대상)의 동 외곽선은 분양 홍보물의 CAD 라인아트
   (KakaoTalk_20260804_165504268_02.jpg 우상단 배치도)에서 벡터화한다.
   지도 캡처보다 해상도가 2배 높고 라벨에 가려진 부분이 없다.
3. 주변 3개 단지(B5블록 호반써밋 1차 / 호반써밋 풍무 II / 풍무역 푸르지오 더마크)는
   `asset/map.png` 에서 필지별로 흰색 건물 폴리곤을 추출한다.
4. 동별 최고층수는 각 단지 홍보물의 동·호 배치도에서 판독한 값을 사용한다.
"""
from __future__ import annotations

import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
from skimage import measure, segmentation

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSET = os.path.join(ROOT, "asset")
OUT = os.path.join(ROOT, "web", "src", "data", "buildings.json")

# --------------------------------------------------------------------------- #
# 1. georeferencing                                                           #
# --------------------------------------------------------------------------- #
# map.png -> VWorld static-map pixel frame (zoom 17, 1000x1000, centre below).
# Fitted by maximising IoU of the two lot-boundary masks (IoU 0.971).
MAP_FIT = dict(s=1.053002, theta=math.radians(-0.2957), tx=37.698, ty=-83.862)
VW_CENTER = (126.7340, 37.6140)
VW_SIZE = 1000
VW_ZOOM = 17
R_MERC = 156543.033928041 / (2 ** VW_ZOOM)          # mercator metres / pixel
EARTH_C = 20037508.342789244


def merc(lon: float, lat: float) -> tuple[float, float]:
    # EARTH_C / pi == equatorial radius, so y = R * ln(tan(pi/4 + lat/2))
    return (lon * EARTH_C / 180.0,
            math.log(math.tan((90.0 + lat) * math.pi / 360.0)) * EARTH_C / math.pi)


def unmerc(x: float, y: float) -> tuple[float, float]:
    return (x * 180.0 / EARTH_C,
            math.degrees(2 * math.atan(math.exp(y * math.pi / EARTH_C)) - math.pi / 2))


CX, CY = merc(*VW_CENTER)


def map_to_lonlat(u: float, v: float) -> tuple[float, float]:
    s, th, tx, ty = MAP_FIT["s"], MAP_FIT["theta"], MAP_FIT["tx"], MAP_FIT["ty"]
    c, si = math.cos(th), math.sin(th)
    x = s * (c * u - si * v) + tx
    y = s * (si * u + c * v) + ty
    return unmerc(CX + (x - VW_SIZE / 2) * R_MERC, CY - (y - VW_SIZE / 2) * R_MERC)


# 3차 라인아트 배치도 -> map.png 픽셀 (건물 마스크 IoU 최적화 결과)
LA_FIT = dict(s=0.485740, theta=math.radians(-0.073), tx=373.79, ty=244.74)
LA_SRC = os.path.join(ASSET, "KakaoTalk_20260804_165504268_02.jpg")
LA_CROP = (600, 60, 1010, 690)


def la_to_map(x: float, y: float) -> tuple[float, float]:
    s, th, tx, ty = LA_FIT["s"], LA_FIT["theta"], LA_FIT["tx"], LA_FIT["ty"]
    c, si = math.cos(th), math.sin(th)
    return (s * (c * x - si * y) + tx, s * (si * x + c * y) + ty)


# --------------------------------------------------------------------------- #
# helpers                                                                     #
# --------------------------------------------------------------------------- #
def disk(r: int) -> np.ndarray:
    y, x = np.mgrid[-r:r + 1, -r:r + 1]
    return x * x + y * y <= r * r


UP = 4


def polygonise(mask: np.ndarray, tol: float = 0.85) -> list[list[float]]:
    """largest outer ring of `mask`, 4x supersampled then Douglas-Peucker"""
    ys, xs = np.nonzero(mask)
    oy, ox = max(0, ys.min() - 2), max(0, xs.min() - 2)
    sub = mask[oy:ys.max() + 3, ox:xs.max() + 3]
    big = np.kron(sub.astype(np.uint8), np.ones((UP, UP), np.uint8))
    big = ndi.binary_closing(big, np.ones((UP + 1, UP + 1)))
    pad = np.pad(big, 3)
    rings = sorted(measure.find_contours(pad.astype(float), 0.5), key=lambda c: -len(c))
    p = measure.approximate_polygon(rings[0] - 3, tolerance=tol * UP)[:, ::-1] / UP
    return [[float(x + ox), float(y + oy)] for x, y in p]


def signed_area(poly) -> float:
    a = 0.0
    for i in range(len(poly)):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % len(poly)]
        a += x0 * y1 - x1 * y0
    return a / 2.0


def ccw(poly):
    return poly if signed_area(poly) > 0 else poly[::-1]


# --------------------------------------------------------------------------- #
# stepped (per-line) volumes                                                  #
# --------------------------------------------------------------------------- #
# Korean tower plans mix several unit "lines" (a vertical stack of one unit per
# floor) in one 동, and lines commonly top out at different floors - a wide low
# wing next to a slim tall one. The 동호수배치도 (unit/floor table) gives an exact
# top floor per line; this section turns that into real stepped geometry
# instead of one flat extrusion at the tallest line's height.
def _side(poly, cx, cy, ux, uy, t):
    return [((p[0] - cx) * ux + (p[1] - cy) * uy) - t for p in poly]


def _clip(poly, dist):
    out = []
    n = len(poly)
    for i in range(n):
        cur, nxt = poly[i], poly[(i + 1) % n]
        dc, dn = dist[i], dist[(i + 1) % n]
        if dc <= 1e-9:
            out.append(cur)
            if dn > 1e-9:
                t = dc / (dc - dn)
                out.append((cur[0] + t * (nxt[0] - cur[0]), cur[1] + t * (nxt[1] - cur[1])))
        elif dn <= 1e-9:
            t = dc / (dc - dn)
            out.append((cur[0] + t * (nxt[0] - cur[0]), cur[1] + t * (nxt[1] - cur[1])))
    return out


def principal_axis(poly):
    """long axis of `poly`, direction pinned so the same shape always gives the
    same end as index 0 - the eigenvector sign alone is not reproducible, and
    both this file and refine_footprints.py have to slice the same way round."""
    xs = np.array([p[0] for p in poly])
    ys = np.array([p[1] for p in poly])
    cx, cy = float(xs.mean()), float(ys.mean())
    cov = np.cov(xs - cx, ys - cy)
    w, v = np.linalg.eigh(cov)
    ux, uy = v[:, int(np.argmax(w))]
    if ux < 0 or (ux == 0 and uy < 0):
        ux, uy = -ux, -uy
    return cx, cy, float(ux), float(uy)


def axis_grid(poly, n, reverse=False):
    """(centre, direction, n+1 cut positions) laying `n` unit lines along the
    footprint's long axis. Reversing flips the direction rather than the list, so
    runs and individual cells are always cut on the same grid."""
    cx, cy, ux, uy = principal_axis(poly)
    if reverse:
        ux, uy = -ux, -uy
    proj = [(p[0] - cx) * ux + (p[1] - cy) * uy for p in poly]
    lo, hi = min(proj), max(proj)
    ts = [lo + (hi - lo) * i / n for i in range(n + 1)]
    ts[0] -= 1.0                                    # bite past the ends so the
    ts[-1] += 1.0                                   # clip cannot shave the tips
    return cx, cy, ux, uy, ts


def _band(poly, cx, cy, ux, uy, t0, t1):
    s = _clip(poly, [-d for d in _side(poly, cx, cy, ux, uy, t0)])
    if s:
        s = _clip(s, _side(s, cx, cy, ux, uy, t1))
    return s if s and len(s) >= 3 else None


def split_by_runs(poly, lines, reverse=False):
    """Cut `poly` into one volume per *run* of equally tall unit lines.

    Lines are laid out along the footprint's long axis, so consecutive lines
    that top out at the same floor belong to one continuous mass - cutting per
    line instead would draw internal walls that don't exist and turn a stepped
    tower into a comb. Returns [{poly, floors, lines: (a, b)}, ...].

    The mapping from table column to axis position is a geometric
    approximation, but for the subject complex the direction is pinned down
    against the per-주택형 highlight sheets (see resolve_line_order).
    """
    n = len(lines)
    runs = []
    start = 0
    for i in range(1, n + 1):
        if i == n or lines[i] != lines[start]:
            runs.append((start, i, lines[start]))
            start = i
    # flipping the axis already sends line i to the far end, so run indices stay
    # in line order either way
    if len(runs) == 1:
        return [dict(poly=poly, floors=runs[0][2], lines=(0, n))]

    cx, cy, ux, uy, ts = axis_grid(poly, n, reverse)
    out = []
    for a, b, floors in runs:
        s = _band(poly, cx, cy, ux, uy, ts[a], ts[b])
        if s:
            out.append(dict(poly=s, floors=floors, lines=(a, b)))
    return out if out else [dict(poly=poly, floors=max(lines), lines=(0, n))]


def split_by_seeds(poly, seeds, groups, scale=1.0, tol=0.9):
    """Cut `poly` into one polygon per group of unit lines, around known seeds.

    Straight cuts along a long axis only work for a straight slab. The 3차 동 are
    V-shaped, and equal bands along the axis then hand one arm a single fat cell
    and slice the other into three - which is what made the roof layout disagree
    with the 동·호 배치도. Growing every line outwards from its own seed point
    instead follows the plan's bend, because the boundaries land midway between
    neighbouring units wherever those units actually are.

    `seeds` are in `poly`'s coordinates, ordered by line; `groups` are (start,
    end) index ranges over them. Returns one polygon (or None) per group.
    """
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    pad = 2.0 / scale
    x0, y0 = min(xs) - pad, min(ys) - pad
    W = int(math.ceil((max(xs) - x0) * scale)) + 4
    H = int(math.ceil((max(ys) - y0) * scale)) + 4
    img = Image.new("L", (W, H), 0)
    ImageDraw.Draw(img).polygon([((x - x0) * scale, (y - y0) * scale) for x, y in poly],
                                fill=255)
    mask = np.array(img) > 127
    _, (ny, nx) = ndi.distance_transform_edt(~mask, return_indices=True)

    mk = np.zeros((H, W), np.int32)
    for i, (sx, sy) in enumerate(seeds, 1):
        px = min(max(int(round((sx - x0) * scale)), 0), W - 1)
        py = min(max(int(round((sy - y0) * scale)), 0), H - 1)
        if not mask[py, px]:                        # a centroid can fall in a notch
            py, px = int(ny[py, px]), int(nx[py, px])
        mk[py, px] = i
    lab = segmentation.watershed(np.zeros((H, W), np.uint8), markers=mk, mask=mask)

    out = []
    for a, b in groups:
        m = mask & (lab >= a + 1) & (lab <= b)
        out.append([(x / scale + x0, y / scale + y0) for x, y in polygonise(m, tol)]
                   if m.any() else None)
    return out


def runs_of(lines):
    """[(start, end, floors), ...] for each run of equally tall unit lines"""
    runs = []
    start = 0
    for i in range(1, len(lines) + 1):
        if i == len(lines) or lines[i] != lines[start]:
            runs.append((start, i, lines[start]))
            start = i
    return runs


def merged_mask(polys, w, h):
    img = Image.new("L", (w, h), 0)
    dr = ImageDraw.Draw(img)
    for p in polys:
        dr.polygon([tuple(pt) for pt in p], fill=255)
    return np.array(img) > 127


# --------------------------------------------------------------------------- #
# line order from the six unit-type highlight sheets                          #
# --------------------------------------------------------------------------- #
# Slicing a footprint along its long axis gives the right *set* of volumes but
# not which end is the 01호 line. The brochure ships one sheet per 주택형, each
# tinting only that type's units on the same plan, so the tinted patch positions
# pin the direction down against the 타입 row read off the 동호수배치도.
UNIT_SHEETS = [
    "KakaoTalk_20260804_165504268.jpg",
    "KakaoTalk_20260804_165504268_01.jpg",
    "KakaoTalk_20260804_165504268_02.jpg",
    "KakaoTalk_20260804_165504268_03.jpg",
    "KakaoTalk_20260804_165504268_04.jpg",
    "KakaoTalk_20260804_165504268_05.jpg",
]


def _sheet_arrays(path):
    im = Image.open(os.path.join(ASSET, path)).convert("RGB")
    a = np.array(im).astype(int)
    g = np.array(im.convert("L")).astype(int)
    return a, g


def _register(ref_lines, g):
    """integer translation aligning this sheet's line work onto the reference"""
    lines = g < 175
    best, bd = (0, 0), -1
    for dy in range(-40, 41, 2):
        for dx in range(-40, 41, 2):
            sh = np.roll(np.roll(lines, dy, axis=0), dx, axis=1)
            v = int((sh & ref_lines).sum())
            if v > bd:
                bd, best = v, (dx, dy)
    dx0, dy0 = best
    for dy in range(dy0 - 2, dy0 + 3):
        for dx in range(dx0 - 2, dx0 + 3):
            sh = np.roll(np.roll(lines, dy, axis=0), dx, axis=1)
            v = int((sh & ref_lines).sum())
            if v > bd:
                bd, best = v, (dx, dy)
    return best


def resolve_line_order(towers_la):
    """-> {dong: {reverse, seeds}}  from the tinted unit patches on each type sheet

    `seeds` is one point per unit line, in line-art crop coordinates, ordered the
    way the 동호수배치도 lists them. Everything downstream - which cell is which
    주택형, where the stepped volumes are cut - hangs off these.
    """
    ref_a, ref_g = _sheet_arrays(UNIT_SHEETS[2])
    ref_lines = (ref_g < 175)[LA_CROP[1]:LA_CROP[3], LA_CROP[0]:LA_CROP[2]]

    # footprint masks in line-art crop coordinates
    H = LA_CROP[3] - LA_CROP[1]
    W = LA_CROP[2] - LA_CROP[0]
    foot = {d: merged_mask([p], W, H) for d, p in towers_la.items()}

    # per sheet: tinted patch centroids inside each footprint
    per_sheet = []
    for path in UNIT_SHEETS:
        a, g = _sheet_arrays(path)
        dx, dy = _register(ref_lines, g[LA_CROP[1]:LA_CROP[3], LA_CROP[0]:LA_CROP[2]])
        sub = a[LA_CROP[1]:LA_CROP[3], LA_CROP[0]:LA_CROP[2]]
        sub = np.roll(np.roll(sub, dy, axis=0), dx, axis=1)
        sat = sub.max(2) - sub.min(2)
        tint = (sat > 18) & (sub.max(2) > 120)
        tint = ndi.binary_opening(tint, disk(1))
        hits = {}
        for d, m in foot.items():
            t = tint & m
            if t.sum() < 30:
                continue
            lab, n = ndi.label(t)
            cs = []
            for i in range(1, n + 1):
                mm = lab == i
                if mm.sum() < 25:
                    continue
                cy, cx = ndi.center_of_mass(mm)
                cs.append((float(cx), float(cy)))
            if cs:
                hits[d] = cs
        per_sheet.append((path, hits))

    # Identify which sheet is which 주택형 from *how many lines* of it each 동 has.
    # The set of 동 alone does not separate 59A from 59B - both live in 405~408 -
    # but the counts do (405 has two 59A lines and one 59B). Score every
    # (sheet, type) pair and take them best-first: assigning sheet by sheet lets an
    # early sheet grab a type a later one matches better. Ties break on the names,
    # so the result does not depend on set iteration order - which is randomised
    # per process and was silently flipping the answer between runs.
    sig = {t: {d: ts.count(t) for d, ts in TYPES3.items() if t in ts} for t in
           sorted({t for ts in TYPES3.values() for t in ts})}
    pairs = []
    for path, hits in per_sheet:
        got = {d: len(cs) for d, cs in hits.items()}
        for t, want in sig.items():
            keys = set(got) | set(want)
            same = sum(1 for d in keys if got.get(d) == want.get(d))
            pairs.append((same / (len(keys) or 1), path, t))
    pairs.sort(key=lambda p: (-p[0], p[1], p[2]))
    sheet_type = {}
    used = set()
    for _, path, t in pairs:
        if path in sheet_type or t in used:
            continue
        sheet_type[path] = t
        used.add(t)

    # Every tinted patch is one unit line, so each 동 ends up with exactly as many
    # seeds as it has lines. Sorting them along the long axis has to reproduce the
    # 타입 row character for character - in one direction or the other - which
    # settles both the line order and which physical cell is which 주택형 without
    # any scoring or tolerance.
    out = {}
    for dong, types in TYPES3.items():
        seeds = [(sheet_type[path], x, y)
                 for path, hits in per_sheet for x, y in hits.get(dong, ())]
        cx, cy, ux, uy = principal_axis(towers_la[dong])
        for rev in (False, True):
            u, v = (-ux, -uy) if rev else (ux, uy)
            order = sorted(seeds, key=lambda s: (s[1] - cx) * u + (s[2] - cy) * v)
            if [s[0] for s in order] == types:
                out[dong] = dict(reverse=rev, seeds=[(x, y) for _, x, y in order])
                break
        else:
            raise AssertionError(
                f"{dong}: {len(seeds)} tinted lines "
                f"{[s[0] for s in sorted(seeds, key=lambda s: (s[1] - cx) * ux + (s[2] - cy) * uy)]}"
                f" do not spell out {types} either way round")
        if os.environ.get("DIAG"):
            print(f"   lines {dong}: {len(seeds)}개 "
                  f"{'역방향' if out[dong]['reverse'] else '정방향'} {types}")
    if os.environ.get("DIAG"):
        print("   sheet types:", {os.path.basename(k)[-6:]: v for k, v in sheet_type.items()})
    return out


# --------------------------------------------------------------------------- #
# 2. 호반써밋 풍무 III  (line art)                                             #
# --------------------------------------------------------------------------- #
def extract_hoban3():
    im = Image.open(LA_SRC).crop(LA_CROP).convert("RGB")
    rgb = np.array(im).astype(int)
    g = np.array(im.convert("L")).astype(int)
    H, W = g.shape

    walls = g < 175
    sat = rgb.max(axis=2) - rgb.min(axis=2)
    pill = ndi.binary_fill_holes(
        ndi.binary_closing((np.abs(g - 123) <= 10) & (sat <= 12), np.ones((7, 7))))
    lp, n = ndi.label(pill)
    pill = np.zeros_like(walls)
    for i in range(1, n + 1):
        m = lp == i
        if m.sum() >= 400:
            pill |= m

    lab, n = ndi.label(walls, structure=np.ones((3, 3)))
    site_line = np.zeros_like(walls)
    for i in range(1, n + 1):
        m = lab == i
        if m.sum() < 400:
            continue
        ys, xs = np.nonzero(m)
        if (np.ptp(xs) > 0.6 * W) or (np.ptp(ys) > 0.6 * H):
            site_line |= m

    filled = ndi.binary_fill_holes(walls & ~site_line)
    cut = ndi.binary_dilation(pill, disk(2))
    notched = filled & ~cut
    # a callout lying across a building leaves a concave pocket; a closing fills
    # pockets but not open ground, and the `cut` mask keeps the repair local
    filled = ndi.binary_fill_holes(notched | (cut & ndi.binary_closing(notched, disk(13))))
    filled = ndi.binary_opening(filled, disk(2))
    filled &= ~ndi.binary_dilation(site_line, np.ones((3, 3)))

    flab, fn = ndi.label(filled)
    items = []
    for i in range(1, fn + 1):
        m = flab == i
        if m.sum() < 700:
            continue
        ys, xs = np.nonzero(m)
        items.append((float(ys.mean()), float(xs.mean()), polygonise(m)))
    items.sort()                                    # north -> south, west -> east
    assert len(items) == 8, f"expected 8 towers, got {len(items)}"
    order = ["407", "406", "408", "405", "401", "404", "402", "403"]
    towers, towers_la = {}, {}
    for (cy, cx, poly), dong in zip(items, order):
        towers_la[dong] = [(x, y) for x, y in poly]
        towers[dong] = [la_to_map(x, y) for x, y in poly]

    site = ndi.binary_fill_holes(ndi.binary_closing(site_line, np.ones((5, 5))))
    site_poly = [la_to_map(x, y) for x, y in polygonise(site, tol=1.6)]
    return towers, towers_la, site_poly


# --------------------------------------------------------------------------- #
# 3. neighbouring complexes  (map.png)                                        #
# --------------------------------------------------------------------------- #
MAPPNG = os.path.join(ASSET, "map.png")
_im = Image.open(MAPPNG).convert("RGB")
_rgb = np.array(_im).astype(int)
_g = np.array(_im.convert("L")).astype(int)
MH, MW = _g.shape
_glyph = _g < 185                                   # label glyphs
_bright = _rgb.min(axis=2) >= 243                   # building fill (and public roads)


def _near(col, tol):
    return np.abs(_rgb - np.array(col)).max(axis=2) <= tol


_lot = _near((240, 232, 216), 5) | _near((232, 224, 206), 5) | _near((236, 228, 210), 3)
_lot = ndi.binary_fill_holes(ndi.binary_closing(_lot, disk(4)))
_lotlab, _ = ndi.label(_lot)

AMENITY_FLOORS = 2      # 근린생활시설/커뮤니티 등, 동 표기 없는 저층 부속 건축물

LOT_SEED = {"hoban3": (470, 300), "hoban1": (660, 320),
            "hoban2": (470, 600), "prugio": (250, 150)}

# 동 라벨 위치 (map.png 픽셀) - 지도 캡처에서 판독
DONG_LABEL = {
    "hoban1": {"106": (621, 293), "105": (650, 312), "104": (738, 302),
               "107": (625, 374), "103": (713, 390), "108": (590, 444),
               "102": (686, 469), "109": (564, 509), "101": (649, 550)},
    "hoban2": {"1501": (403, 531), "1506": (369, 554), "1502": (481, 595),
               "1505": (400, 610), "1503": (573, 642), "1504": (509, 672)},
    "prugio": {"306": (210, 96), "305": (336, 88), "304": (366, 134),
               "303": (304, 156), "307": (210, 171), "301": (354, 203),
               "308": (202, 246), "312": (314, 301), "309": (201, 328),
               "310": (292, 372), "311": (350, 362)},
}
LABEL_RADIUS = 33.0     # px; beyond this a piece is treated as an ancillary block

# 지도만으로는 판별이 안 되는 조각들 (배치도와 대조해 손으로 지정).
# key = 조각 중심 (map.png px), value = None(제외) 또는 층수
OVERRIDE = {
    "hoban2": {(556, 618): None,        # 지하주차장 진입 램프 (건물 아님)
               (349, 540): AMENITY_FLOORS},   # 동 라벨과 가까워 오분류되는 근린생활시설
    "prugio": {(329, 321): AMENITY_FLOORS,    # 동 라벨과 가까워 오분류되는 저층 상가
               (376, 191): AMENITY_FLOORS},
    "hoban1": {(592, 327): AMENITY_FLOORS,
               (720, 348): AMENITY_FLOORS,
               (563, 544): AMENITY_FLOORS},
}


def override_for(cid, cx, cy, tol=4.0):
    for (ox, oy), v in OVERRIDE.get(cid, {}).items():
        if abs(cx - ox) <= tol and abs(cy - oy) <= tol:
            return True, v
    return False, None


def lot_mask(name):
    sx, sy = LOT_SEED[name]
    lid = _lotlab[sy, sx]
    assert lid, f"{name}: lot seed missed"
    return ndi.binary_erosion(_lotlab == lid, disk(2))


def extract_pieces(name):
    roi = lot_mask(name)
    halo = ndi.binary_dilation(_glyph, disk(3)) & _bright
    b = _bright & roi & ~_glyph & ~halo
    b = ndi.binary_closing(b, disk(2))              # heal the drawn wall hairlines
    b = b | (ndi.binary_dilation(_glyph, disk(4)) & ndi.binary_closing(b, disk(6)))
    b = ndi.binary_fill_holes(b & roi)
    lab, n = ndi.label(b)
    out = []
    for i in range(1, n + 1):
        m = lab == i
        if m.sum() < 60:
            continue
        cy, cx = ndi.center_of_mass(m)
        out.append({"cx": float(cx), "cy": float(cy), "area_px": int(m.sum()),
                    "poly": polygonise(m)})
    return out, roi


# --------------------------------------------------------------------------- #
# 4. heights                                                                  #
# --------------------------------------------------------------------------- #
FLOOR_H = 2.90          # 아파트 기준층 층고
ROOF_H = 3.50           # 옥탑/파라펫

# 동별 라인(호 계열)의 주택형 순서 - 동호수배치도 최하단 "타입" 행 그대로.
# 3차는 주택형별 하이라이트 시트가 6장 있어서, 이 순서와 대조하면 라인 배열
# 방향(어느 쪽 끝이 01호 라인인지)까지 실측으로 확정할 수 있다.
# 동·호 배치도 범례 색상 (asset/KakaoTalk_20260804_165525760.png 스와치 실측).
# 렌더러가 3차 옥상에 같은 색으로 라인을 칠한다.
TYPE_COLORS = {
    "59A": "#f6e8b2", "59B": "#eac2a7", "84A": "#b2bfdd",
    "84B": "#cddbbc", "84C": "#c4add2", "84D": "#78a4d0",
}

TYPES3 = {
    "401": ["84C", "84A", "84B", "84D"],
    "402": ["84A", "84B", "84D"],
    "403": ["84C", "84A", "84A", "84B", "84A"],
    "404": ["84C", "84A", "84A", "84B", "84D"],
    "405": ["84C", "84A", "59A", "59B", "59A"],
    "406": ["59B", "59A", "59B", "59A"],
    "407": ["59B", "59A", "59B", "59A"],
    "408": ["59B", "59A", "59B", "59A"],
}

# 동별 "라인"(호 계열)별 최고층. 각 단지 동호수배치도를 직접 판독한 값으로,
# 라인 순서는 배치도 표의 왼쪽->오른쪽 컬럼 순서 그대로다. 값이 전부 같으면
# 사실상 균일한 동이고, 다르면 실제로 단수가 계단식으로 낮아지는 동이다.
LINES = {
    # 호반써밋 풍무 III (B4BL) - 84B 유닛시트 동호수배치도 (전량 직접 판독)
    "401": [29, 29, 29, 24],            # 84C/84A/84B/84D
    "402": [29, 27, 29],                # 84A/84B/84D
    "403": [17, 17, 23, 27, 29],        # 84C/84A/84A/84B/84A
    "404": [16, 18, 23, 25, 25],        # 84C/84A/84A/84B/84D
    "405": [10, 13, 19, 19, 18],        # 84C/84A/59A/59B/59A
    "406": [7, 7, 8, 7],                # 59B/59A/59B/59A
    "407": [8, 15, 18, 18],             # 59B/59A/59B/59A
    "408": [29, 29, 29, 21],            # 59B/59A/59B/59A
    # 풍무역세권 B5블록 호반써밋 (1차). 186P는 2개 라인을 쓰는 최상층 복층형이라
    # 두 라인이 같은 층에서 끝난다.
    "101": [23, 23, 27, 28, 28],
    "102": [25, 25, 28, 28, 28],
    "103": [26, 26, 27, 27, 24],
    "104": [27, 27, 28, 28, 28],
    "105": [14, 14, 14, 14],
    "106": [11, 11],
    "107": [27, 27, 26, 26, 23],
    "108": [28, 28, 28, 27],
    "109": [29, 29, 25, 25, 23],
    # 호반써밋 풍무 II (2차) - 전 라인 동일 최고층 (182A/182B/182C 복층 포함)
    "1501": [38, 38], "1502": [38] * 6, "1503": [38] * 6,
    "1504": [38] * 6, "1505": [38] * 6, "1506": [26] * 4,
    # 풍무역 푸르지오 더 마크 - 동호수배치도 판독 (301~312 전량)
    "301": [14, 14], "302": [29] * 4, "303": [29] * 6,
    "304": [14, 14], "305": [25, 25, 26, 26, 26, 26],
    "306": [29, 29, 29, 29, 28, 28], "307": [29, 29, 29, 29, 28, 28],
    "308": [29, 29, 29, 29, 28, 28], "309": [29, 29, 29, 29, 28, 28],
    "310": [26] * 6, "311": [15, 15], "312": [29] * 6,
}


def height_of(dong: str | None, complex_id: str) -> tuple[int, float]:
    """max floor count + envelope height, used for occluders/labels."""
    if dong is None:
        f = AMENITY_FLOORS
    else:
        f = max(LINES[dong])
    return f, round(f * FLOOR_H + ROOF_H, 2)


def line_heights(dong: str) -> list[float]:
    return [round(f * FLOOR_H + ROOF_H, 2) for f in LINES[dong]]


# --------------------------------------------------------------------------- #
# 5. assemble                                                                 #
# --------------------------------------------------------------------------- #
META = {
    "hoban3": dict(name="호반써밋 풍무 Ⅲ", short="3차", block="B-4BL",
                   units=660, completion="2029-05", subject=True, color="#e8613c"),
    "hoban1": dict(name="풍무역세권 B5블록 호반써밋", short="1차", block="B-5BL",
                   units=956, completion="2028-10", subject=False, color="#8a93a8"),
    "hoban2": dict(name="호반써밋 풍무 Ⅱ", short="2차", block="B-6BL",
                   units=961, completion="2030-01", subject=False, color="#8a93a8"),
    "prugio": dict(name="풍무역 푸르지오 더 마크", short="더마크", block="B-3BL",
                   units=1524, completion="2028-11", subject=False, color="#8a93a8"),
}


def main():
    towers3, towers3_la, site3 = extract_hoban3()
    lines3 = resolve_line_order(towers3_la)
    complexes = []

    # --- 3차: towers from the line art, ancillary blocks from the map ---------
    tower_mask = Image.new("L", (MW, MH), 0)
    dr = ImageDraw.Draw(tower_mask)
    for poly in towers3.values():
        dr.polygon([tuple(p) for p in poly], fill=255)
    tmask = np.array(tower_mask) > 127
    pieces3, _ = extract_pieces("hoban3")

    blds = []
    line_seeds = {}
    for dong, poly in sorted(towers3.items()):
        # seeds come out of the line art, so convert them the same way as the
        # outline they belong to
        seeds_la = lines3[dong]["seeds"]
        seeds = [la_to_map(x, y) for x, y in seeds_la]
        line_seeds[dong] = [list(map_to_lonlat(x, y)) for x, y in seeds]
        runs = runs_of(LINES[dong])
        parts = split_by_seeds(poly, seeds, [(a, b) for a, b, _ in runs], scale=2.0)
        cells = split_by_seeds(poly, seeds, [(i, i + 1) for i in range(len(seeds))],
                               scale=2.0)
        for (a, b, f), seg in zip(runs, parts):
            if not seg:
                continue
            blds.append(dict(
                dong=dong, floors=f, height=round(f * FLOOR_H + ROOF_H, 2), kind="tower",
                poly=[list(map_to_lonlat(x, y)) for x, y in ccw(seg)],
                cells=[dict(type=TYPES3[dong][i],
                            poly=[list(map_to_lonlat(x, y)) for x, y in ccw(cells[i])])
                       for i in range(a, b) if cells[i]]))
    for p in pieces3:
        m = Image.new("L", (MW, MH), 0)
        ImageDraw.Draw(m).polygon([tuple(q) for q in p["poly"]], fill=255)
        if (np.array(m) > 127)[tmask].sum() > 0.25 * p["area_px"]:
            continue                                 # duplicate of a tower
        f, h = height_of(None, "hoban3")
        blds.append(dict(dong=None, floors=f, height=h, kind="amenity",
                         poly=[list(map_to_lonlat(x, y)) for x, y in ccw(p["poly"])]))
    complexes.append(dict(id="hoban3", **META["hoban3"],
                          site=[list(map_to_lonlat(x, y)) for x, y in ccw(site3)],
                          buildings=blds))

    # --- neighbours ---------------------------------------------------------
    for cid in ("hoban1", "hoban2", "prugio"):
        pieces, roi = extract_pieces(cid)
        labels = DONG_LABEL[cid]
        by_dong: dict[str, list] = {}
        amenity_polys = []
        for p in pieces:
            best, bestd = None, 1e9
            for dong, (lx, ly) in labels.items():
                d = math.hypot(p["cx"] - lx, p["cy"] - ly)
                if d < bestd:
                    best, bestd = dong, d
            dong = best if bestd <= LABEL_RADIUS else None
            hit, val = override_for(cid, p["cx"], p["cy"])
            if hit:
                if val is None:
                    continue                        # not a building at all
                amenity_polys.append((p["poly"], val))
                dong = None
            elif dong is None:
                amenity_polys.append((p["poly"], AMENITY_FLOORS))
            else:
                by_dong.setdefault(dong, []).append(p["poly"])
            if os.environ.get("DIAG"):
                shown = dong or ("부속" if hit else "부속(무라벨)")
                print(f"   {cid} c=({p['cx']:6.1f},{p['cy']:6.1f}) a={p['area_px']:5d} -> {shown} d={bestd:5.1f}")

        blds = []
        for dong, polys in by_dong.items():
            merged = polygonise(merged_mask(polys, MW, MH))
            for run in split_by_runs(merged, LINES[dong]):
                h = round(run["floors"] * FLOOR_H + ROOF_H, 2)
                blds.append(dict(dong=dong, floors=run["floors"], height=h, kind="tower",
                                 poly=[list(map_to_lonlat(x, y))
                                       for x, y in ccw(run["poly"])]))
        for poly, f in amenity_polys:
            h = round(f * FLOOR_H + ROOF_H, 2)
            blds.append(dict(dong=None, floors=f, height=h, kind="amenity",
                             poly=[list(map_to_lonlat(x, y)) for x, y in ccw(poly)]))

        site_poly = polygonise(roi, tol=1.5)
        complexes.append(dict(id=cid, **META[cid],
                              site=[list(map_to_lonlat(x, y)) for x, y in ccw(site_poly)],
                              buildings=blds))

    # --- scene origin = centroid of the subject complex ----------------------
    pts = [pt for b in complexes[0]["buildings"] for pt in b["poly"]]
    olon = sum(p[0] for p in pts) / len(pts)
    olat = sum(p[1] for p in pts) / len(pts)

    doc = dict(
        origin=dict(lon=round(olon, 7), lat=round(olat, 7)),
        floorHeight=FLOOR_H, roofHeight=ROOF_H,
        unitTypes=TYPE_COLORS,
        # one point per 3차 unit line, in 동호수배치도 order, so refine_footprints
        # can cut the Kakao footprint on the real cell boundaries
        lineSeeds={d: [[round(lon, 7), round(lat, 7)] for lon, lat in s]
                   for d, s in line_seeds.items()},
        source=dict(
            basemap="asset/map.png (호갱노노 캡처) + VWorld 정적지도 정합",
            towers3="분양 홍보물 CAD 배치도 벡터화",
            note="동별 최고층수는 각 단지 동·호 배치도 판독값. 푸르지오 더 마크는 "
                 "동별 층수 미공개로 지상 29층 일괄 적용.",
        ),
        complexes=complexes,
    )
    for c in complexes:
        for b in c["buildings"]:
            b["poly"] = [[round(x, 7), round(y, 7)] for x, y in b["poly"]]
            for cell in b.get("cells", ()):
                cell["poly"] = [[round(x, 7), round(y, 7)] for x, y in cell["poly"]]
        c["site"] = [[round(x, 7), round(y, 7)] for x, y in c["site"]]

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(doc, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    for c in complexes:
        towers = [b for b in c["buildings"] if b["kind"] == "tower"]
        amen = [b for b in c["buildings"] if b["kind"] == "amenity"]
        named = sorted({b["dong"] for b in towers if b["dong"]})
        print(f"{c['id']:7s} {c['name']:22s} towers={len(towers):2d} "
              f"amenity={len(amen):2d} dong={named}")
    print(f"origin {olon:.6f},{olat:.6f}  ->  {OUT}")


if __name__ == "__main__":
    sys.exit(main())
