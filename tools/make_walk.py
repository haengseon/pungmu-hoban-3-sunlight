"""카카오 렌더 캡처에서 '걸어서 갈 수 있는 면' 을 픽셀 단위로 뽑는다.

    python tools/make_walk.py

건물 사이 길찾기를 하려면 도로 중심선이 아니라 **면**이 필요하다. 단지 안에는
중심선 데이터가 아예 없고(공개 데이터가 없다), 실제로 사람이 걷는 곳은 동 앞 보행로와
단지 내 도로다. 카카오는 그걸 다 그려 두었으므로 캡처에서 캐낸다.

색만으로는 못 가른다 - 이 배율(0.498 m/px)에서 **건물 안과 단지 내 길이 똑같은
흰색(254,254,254)** 이다. 대신 우리는 건물 폴리곤을 이미 갖고 있으니 흰 면에서 건물을
빼는 쪽으로 간다.

결과는 다음 두 개다.

    web/public/walk_mask.png   1비트 마스크 (흰색 = 걸을 수 있음)
    web/src/data/walk.json     마스크 픽셀 <-> 위경도 변환

마스크는 사람이 고치라고 만든 것이다. `web/walk.html`(개발 서버 전용)에서 캡처 위에
얹어 놓고 브러시로 칠하거나 지운 뒤 저장하면 이 파일을 그대로 덮어쓴다. 그래서 이
스크립트는 마스크가 이미 있으면 **덮어쓰지 않는다** - 정말 처음부터 다시 뽑으려면
FORCE=1 을 준다.
"""
from __future__ import annotations

import json
import math
import os

import numpy as np
from scipy import ndimage as ndi

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAP = os.path.join(ROOT, "tools", "out", "kakao_wide.png")
CAP_META = os.path.join(ROOT, "tools", "out", "kakao_wide.json")
OUT_MASK = os.path.join(ROOT, "web", "public", "walk_mask.png")
OUT_META = os.path.join(ROOT, "web", "src", "data", "walk.json")
BUILDINGS = [
    os.path.join(ROOT, "web", "src", "data", "buildings.json"),
    os.path.join(ROOT, "web", "src", "data", "context.json"),
    os.path.join(ROOT, "web", "src", "data", "offices.json"),
]
# 마스크를 만들 범위의 기준이 되는 단지. 이 둘레만 남기고 나머지 동네는 버린다.
RANGE_COMPLEXES = {"prugio", "hoban1", "hoban2", "hoban3", "hoban3_amenity"}

EARTH_C = 20037508.342789244

# 캡처에서 잰 값. 허용오차가 좁은 데는 이유가 있다.
#
# 이 캡처에는 흰색이 두 가지다 - 배경 땅 (250,250,250) 과 길 (254,254,254). 넷밖에
# 차이가 안 나서 넉넉히 잡으면 통째로 섞인다. 섞으면 캡처의 59% 가 '길' 이 되고
# 길찾기가 논밭을 가로지른다. 둘을 갈라 놓고 모양으로 확인해 보면 분명하다:
#   (250,250,250) 50.4%, 최대 내접반경 134.8 m  <- 벌판
#   (254,254,254) 15.6%, 최대 내접반경  21.9 m  <- 도로 폭 그대로다
# 그래서 tol 은 2 다. 건드리지 마라.
ROAD_COLORS = [
    ((254, 254, 202), 10),  # 일반 도로
    ((254, 234, 142), 14),  # 간선도로 (김포대로)
]
PATH_COLORS = [
    ((254, 254, 254), 2),   # 이면도로·보도
    ((246, 246, 242), 3),   # 광장·데크
    # 단지 안은 또 다르다. 필지 바닥(240,232,216) 위에 단지 내 도로가 살짝 어두운
    # 회백색 띠로 그려진다. 색 차이가 8밖에 안 나므로 tol 을 4 위로 올리면 필지가
    # 통째로 딸려 온다. 이 색이 맞다는 근거는 모양이다 - 필지 안에서 9.2% 를 차지하고
    # 최대 내접반경이 3.6 m 다 (7 m 폭 단지 내 도로 그대로).
    ((232, 224, 206), 4),   # 단지 내 도로
    ((245, 243, 238), 3),   # 단지 내 보행로·데크
]

# 걸을 수 없는 것. 물은 확실하고, 녹지는 산책로가 있을 수 있지만 일단 뺀다 -
# 필요하면 편집기에서 칠하는 편이 낫다 (잘못 넣으면 길찾기가 잔디를 가로지른다).
BLOCK_COLORS = [
    ((162, 214, 234), 12),  # 하천·유수지
    ((210, 226, 194), 10),  # 녹지·공원
    ((208, 222, 188), 10),
]

# 건물은 흰 면과 색이 같다. 폴리곤으로 빼되, 벽에 딱 붙은 픽셀은 걸을 수 없으니
# 조금 넉넉히 뺀다 (사람 어깨 폭 + 트레이싱 오차).
BUILDING_PAD_M = 1.5

# 차로 한복판은 걷는 데가 아니다. 걸을 수 있는 면의 가장자리에서 이만큼만 남기고
# 가운데를 판다 - 넓은 도로는 양쪽 보도 두 줄이 되고, 원래 이보다 좁은 단지 내
# 보행로는 그대로 남는다.
#
# 이러면 도로 하나가 양쪽으로 갈라져 '건너가기' 가 사라진다. 횡단보도 데이터가 없어
# 자동으로는 못 잇는다 - 편집기에서 손으로 칠하라는 뜻이고, 그러라고 만든 것이다.
SIDEWALK_M = 4.0

# 다 칠할 필요 없다. 더마크·풍무 1~3차와 그 주변 상가까지가 범위다.
RANGE_PAD_M = 200.0

MIN_BLOB_M2 = 400     # 이보다 작은 조각은 길이 아니다 (라벨·아이콘 잔해)
CLOSE_M = 3.0         # POI 아이콘·글자가 길을 끊은 자리를 메운다
OPEN_M = 1.0          # 점 노이즈 제거


def load_meta():
    m = json.load(open(CAP_META, encoding="utf-8"))
    return m


def to_px(m, lon, lat):
    mx = lon * EARTH_C / 180
    my = math.log(math.tan((90 + lat) * math.pi / 360)) * EARTH_C / math.pi
    return (m["ox"] + (mx - m["mA"]["x"]) * m["sx"],
            m["oy"] + (my - m["mA"]["y"]) * m["sy"])


def main() -> None:
    meta = load_meta()
    img = np.asarray(Image.open(CAP).convert("RGB")).astype(np.int16)
    h, w = img.shape[:2]
    # 위도 보정을 넣은 실제 지상 해상도
    mpp = 1 / meta["sx"] * math.cos(math.radians(37.6165))
    print(f"캡처 {w}x{h}, {mpp:.3f} m/px")

    def hit(colors):
        m = np.zeros((h, w), bool)
        for rgb, tol in colors:
            m |= np.abs(img - np.array(rgb)).max(2) <= tol
        return m

    road = hit(ROAD_COLORS)
    paths = hit(PATH_COLORS)
    walk = (road | paths) & ~hit(BLOCK_COLORS)
    print(f"  도로 {road.mean() * 100:.1f}% + 보행로·이면도로 {paths.mean() * 100:.1f}%")

    # 건물을 뺀다. 흰 면과 색이 같아 색으로는 못 가르지만 폴리곤은 이미 있다.
    stamp = Image.new("1", (w, h), 0)
    d = ImageDraw.Draw(stamp)
    # 범위 판정용은 따로 찍는다 - 분석 대상 단지만이다 (그라센트·업무시설 제외)
    range_stamp = Image.new("1", (w, h), 0)
    rd = ImageDraw.Draw(range_stamp)
    n = 0
    for src in BUILDINGS:
        if not os.path.exists(src):
            continue
        doc = json.load(open(src, encoding="utf-8"))
        for c in doc["complexes"]:
            for b in c["buildings"]:
                poly = [to_px(meta, lon, lat) for lon, lat in b["poly"]]
                d.polygon(poly, fill=1)
                if c["id"] in RANGE_COMPLEXES:
                    rd.polygon(poly, fill=1)
                n += 1
    pad = max(1, int(round(BUILDING_PAD_M / mpp)))
    built = ndi.binary_dilation(np.asarray(stamp, bool), np.ones((pad * 2 + 1,) * 2))
    walk &= ~built
    print(f"  건물 {n}개 제외 (여유 {BUILDING_PAD_M} m)")

    # 순서가 중요하다. 카카오는 글자에 흰 테두리를 둘러 그리는데, 먼저 닫으면 그
    # 테두리들이 한 덩어리로 뭉쳐 라벨 자리가 통째로 '길' 이 된다. 얇은 것을 먼저 털고
    # 나서 남은 진짜 길의 끊긴 자리를 메운다.
    k_close = max(1, int(round(CLOSE_M / mpp)))
    k_open = max(1, int(round(OPEN_M / mpp)))
    walk = ndi.binary_opening(walk, np.ones((k_open, k_open)))
    walk = ndi.binary_closing(walk, np.ones((k_close, k_close)))
    walk &= ~built     # 닫으면서 건물을 다시 먹었을 수 있다

    # 차로 가운데를 판다. 가장자리에서 SIDEWALK_M 안쪽만 남긴다.
    edge = ndi.distance_transform_edt(walk) * mpp
    wide = walk & (edge > SIDEWALK_M)
    walk &= ~wide
    print(f"  차로 가운데 {wide.sum() * mpp**2 / 10000:.1f} ha 제외 "
          f"(가장자리 {SIDEWALK_M} m 만 남김)")

    # 범위를 자른다. 분석 대상 네 단지와 그 부대시설 둘레만 본다.
    near = ndi.binary_dilation(
        np.asarray(range_stamp, bool),
        ndi.generate_binary_structure(2, 2),
        iterations=int(round(RANGE_PAD_M / mpp)))
    walk &= near
    print(f"  범위 밖 제외 (대상 단지에서 {RANGE_PAD_M:.0f} m 안쪽만)")

    lab, cnt = ndi.label(walk)
    if cnt:
        sizes = ndi.sum(walk, lab, range(1, cnt + 1))
        keep = np.flatnonzero(sizes >= MIN_BLOB_M2 / mpp**2) + 1
        walk = np.isin(lab, keep)
        print(f"  덩어리 {cnt} -> {len(keep)}개 (400 m2 미만 제거)")

    # 길찾기는 이 마스크가 얼마나 하나로 이어져 있느냐가 전부다. 미리 알려 준다.
    lab, cnt = ndi.label(walk)
    sizes = ndi.sum(walk, lab, range(1, cnt + 1)) * mpp**2
    order = np.argsort(sizes)[::-1]
    top = ", ".join(f"{sizes[i] / 10000:.1f}ha" for i in order[:4])
    print(f"  이어진 덩어리 {cnt}개 - 큰 것부터: {top}")
    print(f"  걸을 수 있는 면 {walk.sum() * mpp**2 / 10000:.1f} ha")

    # 사람이 브러시로 고친 결과가 이 파일에 들어 있다. 무심코 다시 돌려서 날리는 쪽이
    # 훨씬 아프므로, 이미 있으면 기본은 '안 덮어쓴다' 다.
    if os.path.exists(OUT_MASK) and os.environ.get("FORCE") != "1":
        print(f"{os.path.relpath(OUT_MASK, ROOT)} 가 이미 있다 - 덮어쓰지 않는다 "
              f"(FORCE=1 로 강제)")
        return

    Image.fromarray((walk * 255).astype(np.uint8), "L").convert("1").save(
        OUT_MASK, optimize=True)

    # 마스크 픽셀 <-> 위경도. 캡처 affine 이 회전 없는 메르카토르 정렬이라
    # 네 모서리만 있으면 선형 보간으로 어디든 환산된다.
    def to_lonlat(x, y):
        mx = meta["mA"]["x"] + (x - meta["ox"]) / meta["sx"]
        my = meta["mA"]["y"] + (y - meta["oy"]) / meta["sy"]
        return [round(mx * 180 / EARTH_C, 7),
                round(math.degrees(2 * math.atan(math.exp(my * math.pi / EARTH_C))
                                   - math.pi / 2), 7)]

    json.dump({
        "source": "kakao_wide capture",
        "width": w, "height": h,
        "metresPerPixel": round(mpp, 4),
        # [[서, 북], [동, 북], [동, 남], [서, 남]] - maplibre image 소스와 같은 순서
        "coordinates": [to_lonlat(0, 0), to_lonlat(w, 0),
                        to_lonlat(w, h), to_lonlat(0, h)],
    }, open(OUT_META, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    print(f"{os.path.relpath(OUT_MASK, ROOT)}  "
          f"{os.path.getsize(OUT_MASK) / 1e3:.0f} KB")


if __name__ == "__main__":
    main()
