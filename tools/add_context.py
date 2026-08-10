"""주변 단지의 동을 카카오맵 렌더에서 뽑아 web/src/data/context.json 으로 낸다.

호반 1·2·3차와 더마크는 동호수배치도를 라인 단위까지 판독해 계단형으로 세운다
(build_data.py). 여기 단지들은 라인 자료가 없어 **동 하나에 덩어리 하나**로 세우되,
층수는 동마다 따로 준다 - 한 단지를 최고층 하나로 뭉개면 15층짜리가 29층이 된다.

    python tools/add_context.py

## 어떻게 가르나

카카오는 아파트 필지를 고유한 베이지로 칠한다. 준공은 #f4ede1, 공사 중은 #f0e8d8 로
다르다. 필지를 시드에서 플러드필해 ROI 를 잡고, 그 안의 흰 덩어리를 후보로 본다.

필지 안의 흰 덩어리가 전부 건물은 아니다. 단지 내 도로·보행로·회전교차로도 희다.
**level 1 캡처에서는 둘의 흰색이 다르다**:

    건물 채움   #fdfdfb, #fdfdfc, #fefefc   파랑이 1~2 낮은 따뜻한 흰색
    도로·보행로 #fefefe                     r=g=b 중성 흰색

따뜻한 픽셀만으로 마스크를 만들면 건물 일부(중성으로 렌더된 안쪽)가 떨어져 나가므로,
**모양은 넓은 마스크로 잡고 도로 판정만 따뜻한 픽셀 비율로 한다.**

## 어느 덩어리가 어느 동인가

카카오가 건물 위에 동 번호와 층수 라벨("4-29F-1" = 지하4층~지상29층)을 찍어 주지만
글자를 기계로 읽지는 않는다. 그래서 아래 표에 **동마다 좌표와 층수를 적어 두고**,
뽑힌 덩어리를 가장 가까운 표 항목에 붙인다. 어디에도 안 붙은 덩어리는 버린다 -
도로가 걸러지는 두 번째 그물이다.

층수 출처: 그라센트 2차는 분양 홈페이지 동호수배치도(라인별 층수까지 확인), 1차는
카카오 층수 라벨 판독. 부대시설(어린이집·근린생활시설·관리동)은 단지배치도에서 확인.
"""
from __future__ import annotations

import json
import math
import os

import numpy as np
from scipy import ndimage as ndi
from skimage import measure

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRACE = os.path.join(ROOT, "tools", "out", os.environ.get("NAME", "kakao_gras"))
OUT = os.path.join(ROOT, "web", "src", "data", "context.json")

EARTH_C = 20037508.342789244
FLOOR_H = 2.90

LOTS = ((244, 237, 225), (240, 232, 216))  # 준공 / 공사 중
LOT_TOL = 5
LOOSE = 246        # 덩어리 모양을 잡는 넓은 마스크
MIN_AREA_M2 = 90
MATCH_M = 32       # 표의 좌표에서 이 거리 안이면 그 동으로 본다
# 이보다 크면 동 하나일 수 없다 - 도로가 붙어 한 덩어리가 된 것이다. 그때만 따뜻한
# 픽셀로 잘라 낸다. 따뜻함을 상시 조건으로 걸면 안 된다 - 그라센트 1차 201동처럼
# 중성 흰색으로 렌더되는 동이 통째로 사라진다.
MAX_ONE_DONG_M2 = 1200
SIMPLIFY_M = 1.5

# (동 이름, 지상 최고층, 좌표). 좌표는 카카오 렌더에서 읽은 그 동의 대략 중심.
COMPLEXES = [
    dict(
        id="grascent2", name="풍무역세권 수자인 그라센트 2차", short="그라센트2",
        seed=(126.7265, 37.6196),
        # 분양 홈페이지 동호수배치도. 라인별로는 101=25·25·25·23·23, 102=20·20·19·19,
        # 105=25·26·26·23·23, 106=26·28·28·26·26, 107=26·28·28·27·27 이지만
        # 라인 씨앗 자료가 없어 동별 최고층 하나로 세운다.
        dongs=[
            ("101", 25, (126.726526, 37.619040)),
            ("102", 20, (126.725798, 37.619334)),
            ("103", 15, (126.725228, 37.619562)),
            ("104", 13, (126.724945, 37.619832)),
            ("105", 26, (126.725527, 37.620311)),
            ("106", 28, (126.726305, 37.620042)),
            # 107동은 106동과 같은 평면이다. 카카오 렌더에서는 단지 내 길과
            # 상가가 붙어 한 덩어리라 침식만으로는 팔 하나가 잘려 나간다.
            # 그래서 106동 외곽선을 그대로 옮겨 쓰고, 덩어리에서 그 모양을
            # 뺀 나머지를 상가로 본다.
            ("107", 28, (126.7271460, 37.6197320), "106"),
            ("어린이집", 1, (126.725197, 37.620103)),
            # 배치도의 근린생활시설(1F)은 107동 동편 도로가에 있는데, 카카오가 그
            # 자리를 따로 그리지 않아 넣지 않는다. 주차장 띠를 상가로 잡는 것보다
            # 없는 편이 낫다.
        ],
    ),
    dict(
        id="grascent1", name="풍무역세권 수자인 그라센트 1차", short="그라센트1",
        seed=(126.7290, 37.6180),
        # 분양 동호수배치도. 라인별로는 202=29·29·29·27·27, 204=26·26·26·25·25,
        # 206=28·28·28·26·26, 208=27·27·27·29·29 이지만 동별 최고층 하나로 세운다.
        # 201·209 가 15층으로 나머지와 크게 다르다.
        dongs=[
            ("201", 15, (126.727553, 37.618580)),
            ("202", 29, (126.728272, 37.619307)),
            ("203", 29, (126.728935, 37.618972)),
            ("204", 26, (126.729686, 37.618659)),
            ("205", 26, (126.729751, 37.618112)),
            ("206", 28, (126.729658, 37.617543)),
            ("207", 29, (126.729708, 37.617031)),
            ("208", 29, (126.728636, 37.617740)),
            ("209", 15, (126.728314, 37.618128)),
            ("210", 29, (126.727818, 37.618232)),
            ("상가", 1, (126.727778, 37.619196)),
            ("어린이집", 1, (126.728552, 37.618905)),
            ("관리동", 1, (126.728707, 37.618706)),
        ],
    ),
]


# 3차 필지 안에 있지만 build_data.py 가 세우지 않는 부대시설. 동 번호가 없어서
# 동호수배치도에 안 나오고, 카카오는 흰 사각형으로만 그린다 - 405~408 사이의
# 어린이집과 상가다. 부지 캡처(kakao_trace, 4 px/m)에서 따로 뽑는다.
HOBAN3 = dict(
    id="hoban3_amenity", name="호반써밋 풍무 Ⅲ 부대시설", short="3차 부대시설",
    trace="kakao_trace", seed=(126.7345, 37.6156), open=7,
    dongs=[
        ("어린이집", 1, (126.7345128, 37.616160)),
        ("상가", 1, (126.7347213, 37.615850)),
    ],
)


# --------------------------------------------------------------------------- #
# 미개발 용지의 예상 매스                                                        #
# --------------------------------------------------------------------------- #
# 호반써밋 풍무 II(C5) 남단, 김포대로에 면한 띠는 아직 비어 있다. 카카오가 용지 종류를
# 글자로 찍어 주므로 무엇이 들어설 자리인지는 확실하다.
#
# **다만 필지 경계도 층수도 실측이 아니다.**
#  - 카카오는 이 용지들을 도로와 같은 색(#f7f5f0)으로 칠하고 경계는 점선이라 필지
#    폴리곤을 자동으로 딸 수 없다. 라벨 위치를 읽어 블록 축에 맞춘 사각형으로 놓았다.
#  - 김포시 고시(개발계획·실시계획)의 용적률·최고층수는 HWP 첨부라 확보하지 못했다.
#    층수는 용도지역 통상 규제에서 역산했다: 층수 = 용적률 / 건폐율.
#
# 그래서 kind="planned" 로 내보내고 렌더러가 다른 재질로 세운다. 계획을 읽은 추정이지
# 측량이 아니다.
BLOCK_AXIS = 154.5   # 호반2차 동들의 주축 (동=0°, 반시계+). 이 일대 격자가 이 각이다

PLANNED = dict(
    id="planned", name="풍무역세권 미개발 용지 (예상)", short="예상",
    # (이름, 라벨 좌표, 필지 크기 m, 건폐율, 용적률)
    lots=[
        ("상업용지 A", (126.7317548, 37.6135679), (70, 48), 0.60, 5.0),
        ("상업용지 B", (126.7325449, 37.6134550), (70, 48), 0.60, 5.0),
        ("상업용지 C", (126.7331375, 37.6126513), (70, 48), 0.60, 5.0),
        ("업무용지 A", (126.7344354, 37.6126423), (80, 52), 0.60, 6.0),
        ("업무용지 B", (126.7353384, 37.6121998), (80, 52), 0.60, 6.0),
        ("준주거용지", (126.7323474, 37.6143265), (90, 52), 0.60, 4.0),
        # 광장용지는 건물이 서지 않는 자리라 넣지 않는다
    ],
)


def planned_complex():
    """용지 라벨 위치에 블록 축을 따르는 사각 매스를 세운다"""
    a = math.radians(BLOCK_AXIS)
    ux, uy = math.cos(a), math.sin(a)
    buildings = []
    for name, (lon, lat), (pw, ph), cover, far in PLANNED["lots"]:
        floors = max(2, round(far / cover))
        k = math.sqrt(cover)          # 건폐율만큼 덮도록 필지에서 사방으로 물린다
        w, h = pw * k / 2, ph * k / 2
        mdeg = 1 / (111320 * math.cos(math.radians(lat)))
        ring = []
        for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            dx = sx * w * ux - sy * h * uy
            dy = sx * w * uy + sy * h * ux
            ring.append([round(lon + dx * mdeg, 8), round(lat + dy / 110574, 8)])
        buildings.append({
            "dong": name, "floors": floors, "height": round(floors * FLOOR_H, 2),
            "kind": "planned", "poly": ring,
        })
        print(f"  {name:12s} 건폐율 {cover:.0%} · 용적률 {far:.0%} -> {floors}층 "
              f"({floors * FLOOR_H:.1f} m), 바닥 {pw * k:.0f}x{ph * k:.0f} m")
    return {"id": PLANNED["id"], "name": PLANNED["name"], "short": PLANNED["short"],
            "subject": False, "planned": True, "buildings": buildings}


def to_px(meta, lon, lat):
    mx = lon * EARTH_C / 180
    my = math.log(math.tan((90 + lat) * math.pi / 360)) * EARTH_C / math.pi
    return (meta["ox"] + (mx - meta["mA"]["x"]) * meta["sx"],
            meta["oy"] + (my - meta["mA"]["y"]) * meta["sy"])


def to_lonlat(meta, px, py):
    mx = meta["mA"]["x"] + (px - meta["ox"]) / meta["sx"]
    my = meta["mA"]["y"] + (py - meta["oy"]) / meta["sy"]
    return [round(mx * 180 / EARTH_C, 8),
            round(math.degrees(2 * math.atan(math.exp(my * math.pi / EARTH_C)) - math.pi / 2), 8)]


def lot_labels(img):
    lot = np.zeros(img.shape[:2], bool)
    for c in LOTS:
        lot |= np.abs(img - np.array(c)).max(2) <= LOT_TOL
    lot = ndi.binary_closing(lot, np.ones((1, 45)))
    lot = ndi.binary_closing(lot, np.ones((45, 1)))
    lot = ndi.binary_fill_holes(lot)
    return ndi.label(lot)[0]


def ring_of(blob, meta):
    pad = np.pad(blob, 1)
    cs = measure.find_contours(pad.astype(float), 0.5)
    if not cs:
        return None
    c = measure.approximate_polygon(max(cs, key=len), SIMPLIFY_M * meta["pxPerMetre"] * 0.5)
    if len(c) < 4:
        return None
    return [to_lonlat(meta, c[j][1] - 1, c[j][0] - 1) for j in range(len(c) - 1)]


def load(name):
    base = os.path.join(ROOT, "tools", "out", name)
    meta = json.load(open(base + ".json", encoding="utf-8"))
    img = np.asarray(Image.open(base + ".png").convert("RGB")).astype(np.int16)
    loose = img.min(2) >= LOOSE
    warm = loose & ((img[:, :, 0] - img[:, :, 2]) >= 1)  # 건물 채움만 따뜻하다
    return meta, img, loose, warm, lot_labels(img)


def main() -> None:
    cache = {}
    complexes = []

    for spec in COMPLEXES + [HOBAN3]:
        name = spec.get("trace", os.path.basename(TRACE))
        if name not in cache:
            cache[name] = load(name)
        meta, img, loose, warm, lots = cache[name]
        ppm = meta["pxPerMetre"]
        x, y = (int(round(v)) for v in to_px(meta, *spec["seed"]))
        if lots[y, x] == 0:
            print(f"  {spec['name']:26s} 필지를 못 찾았다")
            continue
        roi = lots == lots[y, x]

        b = loose & roi
        k = spec.get("open", 5)
        b = ndi.binary_opening(b, np.ones((k, k)))
        b = ndi.binary_closing(b, np.ones((11, 11)))
        lab, n = ndi.label(b)

        # 표의 각 동에 가장 가까운 덩어리 하나씩
        targets = [(d[0], d[1], to_px(meta, *d[2])) for d in spec["dongs"]]
        copies = {d[0]: d[3] for d in spec["dongs"] if len(d) > 3}
        best = {}
        carved = 0
        dropped_far = 0
        for i in range(1, n + 1):
            blob = lab == i
            if blob.sum() / ppm**2 < MIN_AREA_M2:
                continue
            ys, xs = np.nonzero(blob)
            cx, cy = xs.mean(), ys.mean()
            hit = min(targets, key=lambda t: math.hypot(cx - t[2][0], cy - t[2][1]))
            d = math.hypot(cx - hit[2][0], cy - hit[2][1]) / ppm
            if d > MATCH_M:
                dropped_far += 1            # 표에 없는 것 - 도로·부속 지붕 등
                continue
            if blob.sum() / ppm**2 > MAX_ONE_DONG_M2:
                # 단지 내 길·광장이 동에 붙어 한 덩어리가 됐다. 침식으로 얇은 목을
                # 끊고, 표의 좌표에 가장 가까운 조각만 되살린다. 색으로 가르는 것보다
                # 튼튼하다 - 카카오가 중성 흰색으로 칠하는 동도 있기 때문이다.
                er = ndi.binary_erosion(blob, np.ones((13, 13)))
                el, en = ndi.label(er)
                cand = []
                for j in range(1, en + 1):
                    piece = el == j
                    if piece.sum() / ppm**2 < 40:
                        continue
                    yy, xx = np.nonzero(piece)
                    cand.append((math.hypot(xx.mean() - hit[2][0], yy.mean() - hit[2][1]), piece))
                if not cand:
                    continue
                near = min(cand, key=lambda c: c[0])[1]
                blob = ndi.binary_dilation(near, np.ones((15, 15))) & blob
                carved += 1
            if hit[0] not in best or blob.sum() > best[hit[0]][0]:
                best[hit[0]] = (blob.sum(), blob, hit[1])

        # 같은 평면을 쓰는 동은 원본 외곽선을 옮겨 쓴다. 붙어 있는 길·상가 때문에
        # 제 모양이 안 나오는 동을 구제하는 길이다. 옮기고 남은 조각은 상가로 낸다.
        extra = {}
        for name, src in copies.items():
            if name not in best or src not in best:
                continue
            blob = best[name][1]
            sy_, sx_ = np.nonzero(best[src][1])
            # 잘린 덩어리의 무게중심은 꼬리 쪽으로 쏠려 있다. 표에 적어 둔 그 동의
            # 좌표를 놓을 자리로 삼는다.
            tgt = next(t[2] for t in targets if t[0] == name)
            dx = int(round(tgt[0] - sx_.mean()))
            dy = int(round(tgt[1] - sy_.mean()))
            # 표 좌표는 눈으로 읽은 값이라 몇 m 어긋난다. 지도의 흰 바닥과 겹치는
            # 넓이가 가장 큰 자리로 미세조정한다 (±8 m, 1 m 격자).
            step = max(1, int(round(ppm)))
            best_ov, best_off = -1, (dx, dy)
            for ex in range(-8 * step, 8 * step + 1, step):
                for ey in range(-8 * step, 8 * step + 1, step):
                    ys2, xs2 = sy_ + dy + ey, sx_ + dx + ex
                    ok = ((ys2 >= 0) & (ys2 < blob.shape[0])
                          & (xs2 >= 0) & (xs2 < blob.shape[1]))
                    ov = int(loose[ys2[ok], xs2[ok]].sum())
                    if ov > best_ov:
                        best_ov, best_off = ov, (dx + ex, dy + ey)
            dx, dy = best_off
            moved = np.zeros_like(blob)
            ys2, xs2 = sy_ + dy, sx_ + dx
            ok = (ys2 >= 0) & (ys2 < blob.shape[0]) & (xs2 >= 0) & (xs2 < blob.shape[1])
            moved[ys2[ok], xs2[ok]] = True
            moved = ndi.binary_closing(moved, np.ones((5, 5)))
            # 옮기고 남는 조각은 단지 내 길이다. 배치도의 근린생활시설은 동편
            # 도로가에 따로 있는데 카카오가 그 자리를 그리지 않는다. 길을 상가로
            # 세우느니 버린다.
            best[name] = (moved.sum(), moved, best[name][2])

        buildings = []
        for name, (_, blob, floors) in sorted(best.items()):
            ring = ring_of(blob, meta)
            if ring is None:
                continue
            buildings.append({
                "dong": name, "floors": floors, "height": round(floors * FLOOR_H, 2),
                "kind": "tower" if name.isdigit() else "amenity", "poly": ring,
            })
        for name, (blob, floors) in sorted(extra.items()):
            ring = ring_of(blob, meta)
            if ring is None:
                continue
            buildings.append({
                "dong": name, "floors": floors, "height": round(floors * FLOOR_H, 2),
                "kind": "amenity", "poly": ring,
            })
        missing = [d[0] for d in spec["dongs"] if d[0] not in best]
        complexes.append({
            "id": spec["id"], "name": spec["name"], "short": spec["short"],
            "subject": False, "buildings": buildings,
        })
        print(f"  {spec['name']:26s} 동 {len(buildings):2d}/{len(spec['dongs'])} · "
              f"도로 잘라냄 {carved} · 미매칭 {dropped_far}"
              + (f" · 누락 {missing}" if missing else ""))

    # 미개발 용지 예상 매스는 보류. 필지 경계를 모르는 채 라벨 위치에 상자를
    # 놓으니 도로·이웃 용지를 밟았다. 김포시 고시의 토지이용계획표와 획지별
    # 건축계획을 받으면 planned_complex() 를 다시 켠다.
    # complexes.append(planned_complex())

    doc = {
        "source": "카카오맵 렌더 캡처 (tools/trace_kakao.mjs LEVEL=1) + 동호수배치도·층수 라벨 판독",
        "floorHeight": FLOOR_H,
        "complexes": complexes,
    }
    json.dump(doc, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    total = sum(len(c["buildings"]) for c in complexes)
    print(f"{os.path.relpath(OUT, ROOT)}  단지 {len(complexes)}  볼륨 {total}  "
          f"{os.path.getsize(OUT) / 1e3:.0f} KB")


if __name__ == "__main__":
    main()
