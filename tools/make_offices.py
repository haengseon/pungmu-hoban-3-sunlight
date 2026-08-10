"""업무시설 용지(D1~D4)에 예상 매스를 세워 web/src/data/offices.json 을 낸다.

    python tools/make_offices.py

아직 아무것도 안 지어진 땅이라 트레이싱할 형상이 없다. 대신 도면에서 뜬 필지
(tools/make_landuse.py 가 낸 landuse.json 의 '업무용지')와 지구단위계획의 층수,
용도지역 용적률로 매스를 역산한다.

  - 획지 번호는 도면에 글자로만 있어 색으로는 못 읽는다. 이 지구의 블록 번호가
    북서 -> 남동 순으로 붙어 있어(B1 그라센트2차가 북서, B5 호반1차가 남동) 업무시설도
    같은 순서로 D1~D4 를 매겼다.
  - 연면적 = 부지면적 x 용적률. 층수로 나눈 값이 건축면적이 된다.
  - 배치는 필지의 최소면적 외접 사각형을 같은 비율로 줄여 가운데 놓는다. 도로에서
    고르게 물러나고 필지 방향을 그대로 따르는, 이 규모 업무동의 가장 흔한 앉힘새다.

실측이 아니라 계획을 읽은 추정이므로 kind 는 planned 로 낸다 - 렌더러가 반투명
연푸른 매스로 그려 실측 동과 구분한다.
"""
from __future__ import annotations

import json
import math
import os

import numpy as np
from scipy.spatial import ConvexHull

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "web", "public", "landuse.json")
OUT = os.path.join(ROOT, "web", "src", "data", "offices.json")

FAR = 5.0          # 용적률 500%
FLOOR_H = 3.6      # 업무·근린생활 층고. 아파트(2.9 m)보다 높지만 대형 오피스만큼은 아니다
# 한 필지를 통짜 매스 하나로 세우면 창고처럼 보인다. 이 규모 업무시설은 동을 나눠
# 사이에 통로와 채광을 두는 게 보통이라, 건축면적을 기준으로 몇 동으로 앉힐지 정한다.
AREA_PER_MASS = 1500
MAX_MASS = 3
GAP_M = 8.0        # 동 사이 간격
LAT0 = 37.6165

# 부지면적이 큰 순이 아니라 자리 순이다. 북서 둘이 D1·D2, 풍무역 쪽 둘이 D3·D4.
# 값은 (코드, lon, lat, 층수, 동 수|None, 방향을 빌려올 코드|None).
# D4 는 필지가 짧고 뭉툭해 최소외접 사각형의 긴 변이 90도 돌아 잡힌다. 같은 가로변에
# 나란히 선 D3 의 방향을 그대로 쓴다.
PLAN = [
    ("D1", 126.7253161, 37.6184922, 10, None, None),
    ("D2", 126.7248629, 37.6179628, 10, None, None),
    ("D3", 126.7343953, 37.6126559, 14, 2, None),
    ("D4", 126.7353542, 37.6122503, 14, None, "D3"),
]
MATCH_M = 60


def to_m(ring, lon0, lat0):
    k = math.cos(math.radians(lat0))
    return np.array([[(lon - lon0) * 111320 * k, (lat - lat0) * 110540] for lon, lat in ring])


def to_lonlat(pts, lon0, lat0):
    k = math.cos(math.radians(lat0))
    return [[round(lon0 + x / (111320 * k), 7), round(lat0 + y / 110540, 7)] for x, y in pts]


def min_area_rect(pts):
    """필지를 감싸는 최소 면적 사각형. 회전 캘리퍼스 - 모든 볼록껍질 변을 축으로 시험한다."""
    hull = pts[ConvexHull(pts).vertices]
    best = None
    for i in range(len(hull)):
        e = hull[(i + 1) % len(hull)] - hull[i]
        n = np.linalg.norm(e)
        if n < 1e-9:
            continue
        u = e / n
        v = np.array([-u[1], u[0]])
        a, b = hull @ u, hull @ v
        area = (a.max() - a.min()) * (b.max() - b.min())
        if best is None or area < best[0]:
            best = (area, u, v, (a.min() + a.max()) / 2, (b.min() + b.max()) / 2,
                    a.max() - a.min(), b.max() - b.min())
    _, u, v, ca, cb, w, h = best
    return u, v, ca * u + cb * v, w, h


def polygon_area(pts):
    x, y = pts[:, 0], pts[:, 1]
    return abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) / 2


def main() -> None:
    fc = json.load(open(SRC, encoding="utf-8"))
    lots = [f for f in fc["features"] if f["properties"].get("use") == "업무용지"]
    k = math.cos(math.radians(LAT0))

    buildings = []
    axes = {}
    for code, lon, lat, floors, masses, align in PLAN:
        near = min(lots, key=lambda f: math.hypot(
            (f["properties"]["at"][0] - lon) * 111320 * k,
            (f["properties"]["at"][1] - lat) * 110540))
        d = math.hypot((near["properties"]["at"][0] - lon) * 111320 * k,
                       (near["properties"]["at"][1] - lat) * 110540)
        if d > MATCH_M:
            print(f"  {code} 필지를 못 찾았다 ({d:.0f} m)")
            continue
        lon0, lat0 = near["properties"]["at"]
        ring = to_m(near["geometry"]["coordinates"][0][:-1], lon0, lat0)
        lot_area = polygon_area(ring)
        u, v, c, w, h = min_area_rect(ring)
        if align and align in axes:
            # 방향만 빌리고 크기는 이 필지에서 다시 잰다
            u, v = axes[align]
            a, b = ring @ u, ring @ v
            c = (a.min() + a.max()) / 2 * u + (b.min() + b.max()) / 2 * v
            w, h = a.max() - a.min(), b.max() - b.min()
        axes[code] = (u, v)

        foot = lot_area * FAR / floors
        # 외접 사각형은 필지보다 크므로, 그 사각형을 같은 비율로 줄여 건축면적을 맞춘다
        f = math.sqrt(foot / (w * h))
        if f > 0.92:      # 필지를 거의 다 덮으면 도로에서 물러설 자리가 없다
            f = 0.92
            foot = w * h * f * f
        bw, bh = w * f, h * f
        # 긴 변을 따라 나눈다. 사이를 벌린 만큼 전체 길이를 늘려 건축면적을 지키되,
        # 필지 밖으로 나가지 않는 선에서만 늘린다.
        n = masses or max(1, min(MAX_MASS, round(foot / AREA_PER_MASS)))
        along, across = (u, v) if bw >= bh else (v, u)
        span, width = (bw, bh) if bw >= bh else (bh, bw)
        limit = 0.94 * (w if bw >= bh else h)
        total = min(span + (n - 1) * GAP_M, limit)
        seg = (total - (n - 1) * GAP_M) / n
        for j in range(n):
            mid = -total / 2 + j * (seg + GAP_M) + seg / 2
            mc = c + mid * along
            corners = [mc + sa * seg / 2 * along + sb * width / 2 * across
                       for sa, sb in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
            buildings.append({
                "dong": f"{code}-{j + 1}" if n > 1 else code,
                "kind": "planned",
                "floors": floors,
                "height": round(floors * FLOOR_H, 1),
                "poly": to_lonlat(corners, lon0, lat0),
            })
        built = n * seg * width
        print(f"  {code}  부지 {lot_area:6.0f} m2  {floors:2d}층  {n}동  "
              f"건축면적 {built:5.0f} m2 (건폐율 {built / lot_area * 100:2.0f}%)  "
              f"높이 {floors * FLOOR_H:.1f} m")

    doc = {
        "source": "김포 풍무역세권 도시개발사업 토지이용계획도 + 용적률 500% 역산",
        "floorHeight": FLOOR_H,
        "complexes": [{
            "id": "office",
            "name": "업무시설 (예상)",
            "short": "업무",
            "subject": False,
            "buildings": buildings,
        }],
    }
    json.dump(doc, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{os.path.relpath(OUT, ROOT)}  {len(buildings)}동")


if __name__ == "__main__":
    main()
