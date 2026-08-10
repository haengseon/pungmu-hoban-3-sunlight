"""Replace the footprints in buildings.json with ones traced off the Kakao basemap.

`build_data.py` owns the heights (동호수배치도 판독값) and gives every 동 a position
good to a few metres. Kakao renders the real 건축물 polygons for all four complexes -
tracing those and keeping build_data's floor table gives masses that rise exactly
out of the white shapes the user sees under them.

Three things make the trace usable as geometry rather than as a blob:

* the ROI is Kakao's own **필지 fill**, flood-filled, not the (drifted) site polygon.
  Public roads are painted white too, so anything derived from a padded site
  polygon dragged whole streets in as "buildings";
* 동 번호/면적 labels are punched out of the fill, which notches the buildings they
  sit on. The notch is repaired by a closing that is masked to the label's own
  neighbourhood, so nothing else in the image is dilated;
* every 동 is finally **regularised to its own rectangular grid**: the minimum-area
  rectangle gives the building's axis, the mask is quantised on a 1.5 m cell in
  that frame, and the resulting staircase is the polygon. Apartment blocks are
  rectilinear in their own frame, so this removes the rasterisation ragged edge
  (which showed up as false vertical creases on the 3D walls) and turns a slab
  back into a slab.

Run order:
    node tools/trace_kakao.mjs      (app must be serving)
    python tools/refine_footprints.py
"""
from __future__ import annotations

import json
import math
import os
import shutil
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
from scipy.spatial import ConvexHull
from skimage import measure

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_data import (  # noqa: E402
    FLOOR_H, LINES, ROOF_H, TYPES3, ccw, runs_of, split_by_runs, split_by_seeds, unmerc,
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "web", "src", "data", "buildings.json")
TRACE_PNG = os.path.join(ROOT, "tools", "out", "kakao_trace.png")
TRACE_JSON = os.path.join(ROOT, "tools", "out", "kakao_trace.json")

# ⚠ 이 파일의 NOT_BUILDING·DONG_ANCHOR 좌표는 **특정 캡처의 픽셀 좌표**다.
# tools/out/kakao_trace.png 를 다시 찍으면 프레이밍이 몇 px 어긋나고(예: oy 2137 -> 2173,
# 9 m) 그 좌표들이 전부 빗나가 동이 통째로 사라진다. 재캡처했다면 여기 좌표부터
# 다시 잡아야 한다. 확인 방법은 `npm run check` - 동 수와 3차 주택형 배열이 먼저 깨진다.
AMENITY_FLOORS = 1  # build_data.py 와 같은 값. 근생·상가·어린이집은 1층으로 세운다

# Kakao's 필지(대지) fills. The lighter tones are the internal walkways drawn on
# top of the lot; both are flood-filled into one region, so listing them just
# makes the closing that joins the lot together cheaper.
LOT_FILL = [(240, 232, 216), (232, 224, 206)]
# Kakao's 건축물 fill is a hair warmer than the paper-white background. Taking
# "almost white" instead swallows every unbuilt white parcel inside the lot.
BLD_FILL = (253, 253, 251)

# Which 동 each complex must end up with, so a 동 that build_data could not place
# is caught here instead of silently becoming a 2층 상가.
COMPLEX_DONGS = {
    "hoban3": [f"4{i:02d}" for i in range(1, 9)],
    "hoban1": [f"1{i:02d}" for i in range(1, 10)],
    "hoban2": [f"150{i}" for i in range(1, 7)],
    "prugio": [f"3{i:02d}" for i in range(1, 13)],
}
# 301·302 sit under the complex-name label on 호갱노노's capture, so build_data
# never recovers them; these are their 동 번호 label positions read off the Kakao
# trace itself. A disk around the label is enough to claim the right blocks.
DONG_ANCHOR = {
    "301": (126.733055, 37.617224),
    "302": (126.732519, 37.617151),
}
ANCHOR_R_M = 22.0

# Kakao draws these as 건축물 polygons but the 배치도 says they are not buildings.
# They carry no 동 번호 and no 면적 label, sit flush against a real 동, and look
# exactly like an undivided wing in the raster - there is nothing in the image to
# separate them from a slab, so they are named here. Any point inside the piece
# will do; run with DIAG=1 to print every block's centroid.
NOT_BUILDING = [
    (126.734513, 37.616157),   # 408동 북동쪽 정사각형
    (126.734721, 37.615848),   # 405동 서쪽 ㄴ자
]

CELL_M = 1.0            # regularisation cell
MIN_AREA_M2 = 45.0      # smaller white patches are street furniture, not buildings
MIN_WIDTH_M = 6.0       # narrowest real building; a 보행로/차도 is thinner
MAX_SLENDER = 8.0       # length / width above this is a road, not a building
JOIN_EDGE_M = 5.0       # shared edge needed before a block joins a 동
JOIN_MAX_RATIO = 1.2    # ... and how big it may be relative to what the 동 holds


# Disk-shaped morphology via the Euclidean distance transform: a 48 px dilation
# with an explicit structuring element on a 3120x4242 frame takes minutes, the
# EDT is one linear pass.
def dilate(m, r):
    return ndi.distance_transform_edt(~m) <= r


def erode(m, r):
    return ndi.distance_transform_edt(m) > r


def close(m, r):
    return erode(dilate(m, r), r)


def open_(m, r):
    return dilate(erode(m, r), r)


def crop_of(m, pad=2):
    """(slice, slice) around the true pixels of `m`, padded and clamped"""
    ys, xs = np.nonzero(m)
    pad = int(round(pad))
    return (slice(max(0, ys.min() - pad), min(m.shape[0], ys.max() + pad + 1)),
            slice(max(0, xs.min() - pad), min(m.shape[1], xs.max() + pad + 1)))


def rect_angle(xs, ys):
    """orientation of the minimum-area bounding rectangle, radians in [-pi/4, pi/4]"""
    pts = np.column_stack([xs, ys]).astype(float)
    if len(pts) > 3:
        try:
            pts = pts[ConvexHull(pts).vertices]
        except Exception:
            pass
    best, bth = math.inf, 0.0
    n = len(pts)
    for i in range(n):
        dx, dy = pts[(i + 1) % n] - pts[i]
        if dx == 0 and dy == 0:
            continue
        th = math.atan2(dy, dx)
        c, s = math.cos(th), math.sin(th)
        u = c * pts[:, 0] + s * pts[:, 1]
        v = -s * pts[:, 0] + c * pts[:, 1]
        a = (u.max() - u.min()) * (v.max() - v.min())
        if a < best:
            best, bth = a, th
    return (bth + math.pi / 4) % (math.pi / 2) - math.pi / 4


def outline_angle(mask, ppm):
    """the shape's own orthogonal frame, radians in [-pi/4, pi/4]

    A wing-shaped 동 has no single minimum-area rectangle worth the name, so take
    the dominant wall direction instead: simplify the raster staircase away, then
    take the length-weighted circular mean of the edge bearings modulo 90 degrees.
    Getting this wrong by two degrees is what puts a sawtooth on a 40 m wall.
    """
    ring = max(measure.find_contours(np.pad(mask, 1).astype(float), 0.5), key=len) - 1
    ring = measure.approximate_polygon(ring, tolerance=0.75 * ppm)
    cs = sn = 0.0
    for i in range(len(ring) - 1):
        dy, dx = ring[i + 1] - ring[i]
        L = math.hypot(dx, dy)
        if L < 1.5 * ppm:
            continue
        th = math.atan2(dy, dx)
        cs += L * L * math.cos(4 * th)
        sn += L * L * math.sin(4 * th)
    if cs == 0 and sn == 0:
        ys, xs = np.nonzero(mask)
        return rect_angle(xs, ys)
    th = math.atan2(sn, cs) / 4.0
    return (th + math.pi / 4) % (math.pi / 2) - math.pi / 4


def regularise(mask, ppm, cell_m=CELL_M):
    """rectilinear outline of `mask` in the shape's own axis frame"""
    sl = crop_of(mask, 2)
    oy, ox = sl[0].start, sl[1].start
    mask = mask[sl]
    ys, xs = np.nonzero(mask)
    th = outline_angle(mask, ppm)
    c, s = math.cos(th), math.sin(th)

    k = max(2, int(round(cell_m * ppm)))
    u = c * xs + s * ys
    v = -s * xs + c * ys
    u0, v0 = u.min(), v.min()
    gu = ((u - u0) / k).astype(int)
    gv = ((v - v0) / k).astype(int)
    grid = np.zeros((gv.max() + 1, gu.max() + 1), np.int32)
    np.add.at(grid, (gv, gu), 1)
    occ = grid >= 0.5 * k * k
    if not occ.any():
        occ = grid > 0
    occ = ndi.binary_fill_holes(occ)
    lab, n = ndi.label(occ)
    if n > 1:
        sizes = ndi.sum(occ, lab, range(1, n + 1))
        occ = lab == (int(np.argmax(sizes)) + 1)

    ring = max(measure.find_contours(np.pad(occ, 1).astype(float), 0.5), key=len) - 1
    out = []
    for gvv, guu in ring[:-1]:                      # find_contours repeats the start
        uu = u0 + (guu + 0.5) * k
        vv = v0 + (gvv + 0.5) * k
        out.append((c * uu - s * vv + ox, s * uu + c * vv + oy))

    # the staircase is axis-aligned in the rotated frame, so collapse each run
    merged = []
    for p in out:
        while len(merged) >= 2:
            a, b = merged[-2], merged[-1]
            cr = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
            if abs(cr) > 1e-6:
                break
            merged.pop()
        merged.append(p)
    if len(merged) >= 3:
        out = merged
    return [(float(x), float(y)) for x, y in out]


def shape_stats(mask, ppm):
    """(area m2, inscribed width m, length m) - enough to spot a road"""
    mask = mask[crop_of(mask, 2)]
    area = float(mask.sum()) / ppm ** 2
    width = 2.0 * float(ndi.distance_transform_edt(np.pad(mask, 1)).max()) / ppm
    ys, xs = np.nonzero(mask)
    th = rect_angle(xs[::7] if len(xs) > 400 else xs, ys[::7] if len(ys) > 400 else ys)
    c, s = math.cos(th), math.sin(th)
    u = c * xs + s * ys
    v = -s * xs + c * ys
    length = max(np.ptp(u), np.ptp(v)) / ppm
    return area, width, length


def is_building(mask, ppm):
    area, width, length = shape_stats(mask, ppm)
    if area < MIN_AREA_M2 or width < MIN_WIDTH_M:
        return False, (area, width, length)
    if length / max(width, 1e-6) > MAX_SLENDER:
        return False, (area, width, length)
    return True, (area, width, length)


def main():
    doc = json.load(open(DATA, encoding="utf-8"))
    meta = json.load(open(TRACE_JSON, encoding="utf-8"))
    im = Image.open(TRACE_PNG).convert("RGB")
    rgb = np.array(im).astype(int)
    g = np.array(im.convert("L")).astype(int)
    H, W = g.shape
    ppm = meta["pxPerMetre"]
    print(f"trace {W}x{H}  {ppm:.3f} px/m  level {meta.get('level')}")

    EARTH_C = 20037508.342789244

    def merc(lon, lat):
        return (lon * EARTH_C / 180.0,
                math.log(math.tan((90.0 + lat) * math.pi / 360.0)) * EARTH_C / math.pi)

    def to_px(lon, lat):
        mx, my = merc(lon, lat)
        return (meta["ox"] + (mx - meta["mA"]["x"]) * meta["sx"],
                meta["oy"] + (my - meta["mA"]["y"]) * meta["sy"])

    def to_lonlat(px, py):
        mx = meta["mA"]["x"] + (px - meta["ox"]) / meta["sx"]
        my = meta["mA"]["y"] + (py - meta["oy"]) / meta["sy"]
        return unmerc(mx, my)

    def fill_px(polys):
        img = Image.new("L", (W, H), 0)
        dr = ImageDraw.Draw(img)
        for p in polys:
            dr.polygon([to_px(lon, lat) for lon, lat in p], fill=255)
        return np.array(img) > 127

    glyph = g < 170                          # 동 번호 / 면적 / 층수 라벨
    white = np.abs(rgb - np.array(BLD_FILL)).max(axis=2) <= 1

    # every 필지 in one pass; each complex then just picks the piece it sits on
    lot = np.zeros((H, W), bool)
    for col in LOT_FILL:
        lot |= np.abs(rgb - np.array(col)).max(axis=2) <= 8
    lot = ndi.binary_fill_holes(close(lot, 3 * ppm))
    lotlab, _ = ndi.label(lot)

    out_complexes = []
    for c in doc["complexes"]:
        site = fill_px([c["site"]])
        ids, cts = np.unique(lotlab[site], return_counts=True)
        keep = [(i, n) for i, n in zip(ids, cts) if i]
        assert keep, f"{c['id']}: no 필지 under the site polygon"
        lid = max(keep, key=lambda t: t[1])[0]

        # everything from here on is one lot's business, so work on its bounding
        # box - the morphology radii are tens of pixels and the full frame is 13 Mpx
        sl = crop_of(lotlab == lid, int(round(30 * ppm)))
        oy, ox = sl[0].start, sl[1].start
        roi = lotlab[sl] == lid

        # labels are punched out of the fill; repair only inside their own halo so
        # the closing cannot bridge two buildings that merely stand close together
        # Open first: POI names are drawn with a white halo, and closing that halo
        # before the opening manufactures a building out of the caption itself.
        b = ndi.binary_fill_holes(white[sl] & roi & ~glyph[sl])
        b = open_(b, max(2, 0.7 * ppm))
        halo = dilate(glyph[sl] & roi, 1.2 * ppm)
        b = b | (halo & close(b, 2.2 * ppm))
        b = ndi.binary_fill_holes(b & roi)

        # A 동 is drawn as a run of per-세대 blocks separated by hairlines. Merging
        # first would fuse neighbouring 동 through narrow gaps, so classify every
        # block by which 동's known region it sits in, then merge inside each 동.
        claims = []
        have = {v["dong"] for v in c["buildings"] if v["dong"]}
        for dong in COMPLEX_DONGS[c["id"]]:
            if dong in have:
                reg = dilate(
                    fill_px([v["poly"] for v in c["buildings"] if v["dong"] == dong])[sl],
                    12 * ppm)
            else:
                assert dong in DONG_ANCHOR, f"{c['id']}: {dong} has no footprint or anchor"
                ax, ay = to_px(*DONG_ANCHOR[dong])
                yy, xx = np.ogrid[sl[0], sl[1]]
                reg = (xx - ax) ** 2 + (yy - ay) ** 2 <= (ANCHOR_R_M * ppm) ** 2
            claims.append((dong, reg))

        veto = []
        for lon, lat in NOT_BUILDING:
            vx, vy = to_px(lon, lat)
            vx -= ox
            vy -= oy
            if 0 <= vy < b.shape[0] and 0 <= vx < b.shape[1]:
                veto.append((int(round(vy)), int(round(vx))))

        lab, n = ndi.label(b)
        blocks = []
        dropped = 0
        for i in range(1, n + 1):
            m = lab == i
            if m.sum() < (3.0 * ppm) ** 2:
                continue
            if any(m[vy, vx] for vy, vx in veto):
                dropped += 1
                if os.environ.get("DIAG"):
                    print(f"   veto {c['id']} area={m.sum() / ppm ** 2:6.0f} (건물 아님)")
                continue
            ok, (area, width, length) = is_building(m, ppm)
            if not ok:
                dropped += 1
                if os.environ.get("DIAG"):
                    print(f"   drop {c['id']} area={area:7.0f} w={width:5.1f} "
                          f"len={length:6.1f}")
                continue
            blocks.append(m)

        # Seed from the known 동 positions, then grow by adjacency. build_data's
        # positions come from a lower-resolution capture and often cover only part
        # of a wing-shaped 동, so an overlap test alone leaves the far wing orphaned
        # - but a wing is always in contact with the rest of its own 동.
        owner = [None] * len(blocks)
        for i, m in enumerate(blocks):
            a = int(m.sum())
            best, bo = None, 0
            for dong, region in claims:
                o = int((m & region).sum())
                if o > bo:
                    best, bo = dong, o
            if best is not None and bo >= 0.45 * a:
                owner[i] = best
        order = sorted(range(len(blocks)), key=lambda i: blocks[i].sum())
        changed = True
        while changed:
            changed = False
            for dong, _ in claims:
                mine = [blocks[i] for i in range(len(blocks)) if owner[i] == dong]
                if not mine:
                    continue
                un = mine[0].copy()
                for m in mine[1:]:
                    un |= m
                held = int(un.sum())
                r = 1.5 * ppm
                reach = dilate(un, r)
                for i in order:
                    m = blocks[i]
                    if owner[i] is not None:
                        continue
                    # a unit-line seam runs the full depth of the 동, so ask for a
                    # real shared edge - a corner touch is two separate buildings
                    if int((m & reach).sum()) / r < JOIN_EDGE_M:
                        continue
                    # and a wing never outweighs the 동 it hangs off; a neighbouring
                    # building that merely abuts one does
                    if int(m.sum()) > JOIN_MAX_RATIO * held:
                        continue
                    owner[i] = dong
                    changed = True

        by_dong: dict[str, list] = {}
        amenity = []
        for i, m in enumerate(blocks):
            if os.environ.get("DIAG"):
                cy, cx = ndi.center_of_mass(m)
                lon, lat = to_lonlat(cx + ox, cy + oy)
                print(f"   block {c['id']} ({lon:.6f},{lat:.6f}) "
                      f"area={m.sum() / ppm ** 2:6.0f} -> {owner[i] or '상가'}")
            if owner[i]:
                by_dong.setdefault(owner[i], []).append(m)
            else:
                amenity.append(m)

        blds = []
        for dong, masks in by_dong.items():
            merged = masks[0].copy()
            for m in masks[1:]:
                merged |= m
            merged = ndi.binary_fill_holes(close(merged, max(2, 2.0 * ppm)))
            poly = regularise(merged, ppm)
            lines = LINES.get(dong)
            if not lines:
                continue
            ring = lambda p: [[round(v, 7) for v in to_lonlat(x + ox, y + oy)]  # noqa: E731
                              for x, y in ccw(p)]
            seeds = doc.get("lineSeeds", {}).get(dong)
            if seeds:
                # cut on the real unit-line seeds read off the 동호수배치도, so the
                # stepped volumes and the roof cells land on the same boundaries
                pts = [(x - ox, y - oy) for x, y in (to_px(*s) for s in seeds)]
                runs = runs_of(lines)
                parts = split_by_seeds(poly, pts, [(a, b) for a, b, _ in runs])
                cells = split_by_seeds(poly, pts, [(i, i + 1) for i in range(len(pts))])
                types = TYPES3[dong]
                for (a, b, f), seg in zip(runs, parts):
                    if not seg:
                        continue
                    blds.append(dict(
                        dong=dong, floors=f, height=round(f * FLOOR_H + ROOF_H, 2),
                        kind="tower", poly=ring(seg),
                        cells=[dict(type=types[i], poly=ring(cells[i]))
                               for i in range(a, b) if cells[i]]))
                continue
            for run in split_by_runs(poly, lines):
                f = run["floors"]
                blds.append(dict(
                    dong=dong, floors=f, height=round(f * FLOOR_H + ROOF_H, 2),
                    kind="tower", poly=ring(run["poly"])))
        for m in amenity:
            poly = regularise(m, ppm)
            blds.append(dict(
                dong=None, floors=AMENITY_FLOORS,
                height=round(AMENITY_FLOORS * FLOOR_H + ROOF_H, 2), kind="amenity",
                poly=[[round(v, 7) for v in to_lonlat(x + ox, y + oy)]
                      for x, y in ccw(poly)]))

        got = sorted({v["dong"] for v in blds if v["dong"]})
        missing = [d for d in COMPLEX_DONGS[c["id"]] if d not in got]
        print(f"{c['id']:7s} towers={sum(1 for v in blds if v['dong']):3d} "
              f"amenity={sum(1 for v in blds if not v['dong']):2d} 동={len(got)} "
              f"버림={dropped}" + (f"  MISSING {missing}" if missing else ""))

        site_poly = max(measure.find_contours(np.pad(roi, 1).astype(float), 0.5), key=len) - 1
        site_poly = measure.approximate_polygon(site_poly, tolerance=1.5 * ppm)[:, ::-1]
        out_complexes.append({
            **c,
            "site": [[round(v, 7) for v in to_lonlat(float(x) + ox, float(y) + oy)]
                     for x, y in site_poly],
            "buildings": blds,
        })

    doc["complexes"] = out_complexes
    doc["source"]["footprints"] = (
        "카카오맵 건축물 폴리곤 트레이싱 (tools/trace_kakao.mjs, level 1 / 4 px·m⁻¹) "
        "+ 동별 직교 정규화")
    if not os.path.exists(DATA + ".pre-kakao"):
        shutil.copyfile(DATA, DATA + ".pre-kakao")
    json.dump(doc, open(DATA, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("wrote", DATA)


if __name__ == "__main__":
    main()
