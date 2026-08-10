"""토지이용계획도(asset/ground/계획도1.jpg)를 벡터로 떠서 web/src/data/landuse.json 을 낸다.

    python tools/make_landuse.py

도면은 S=1/3,000 정북 도면이다. 블록 기호 B1~B5·C5 가 우리가 이미 좌표를 아는 단지라
(B1 그라센트2, B2 그라센트1, B3 더마크, B4 호반3차, B5 호반1차, C5 호반2차) 여섯 점으로
상사변환을 맞췄다 - 축척 0.529 m/px, 회전 -0.2°(정북), 잔차 평균 18 m. 잔차 대부분은
'블록 기호 위치 vs 건물 무게중심' 차이라 변환 자체는 그보다 정확하다.

용지는 범례 스와치에서 뽑은 색으로 가른다. 도면을 이미지로 얹지 않고 폴리곤으로 떠서
쓰는 이유는, 얹으면 카카오 지면과 색이 겹쳐 지저분해지고 확대하면 흐려지기 때문이다.

구역 경계는 빨간 일점쇄선이라 끊겨 있어 따로 추적하지 않는다. 대신 분류된 용지 전체를
합쳐 닫고(도로 폭만큼) 그 외곽선을 쓴다 - 결과는 같은 자리다.

필지도 구역도 마지막에 regularize() 로 직선을 맞춰 낸다. 색면을 따라 딴 윤곽은 글자와
필지선, JPEG 얼룩 때문에 톱니가 나는데, 실제 필지는 사각형이면 사각형이라 그대로 두면
안 된다. 결과는 tools/_shapes.py 로 카카오 지면 위에 겹쳐 눈으로 본다.
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
SRC = os.path.join(ROOT, "asset", "ground", "계획도1.jpg")
# public/ 로 낸다. 번들에 인라인으로 넣으면 maplibre 가 워커로 넘길 때 로드를
# 끝내지 못하고 조용히 멈춘다 - URL 로 주면 워커가 직접 받아 문제가 없다.
OUT = os.path.join(ROOT, "web", "public", "landuse.json")

EARTH_C = 20037508.342789244

# 도면 px <-> 실제 좌표 기준점 (블록 기호 중심 <-> 단지 건물 무게중심)
CONTROL = [
    ((1252, 552), (126.725939, 37.619748)),   # B1 그라센트 2차
    ((1856, 862), (126.728873, 37.618294)),   # B2 그라센트 1차
    ((2306, 1118), (126.732282, 37.617020)),  # B3 더마크
    ((2710, 1410), (126.734466, 37.615561)),  # B4 호반 3차
    ((3010, 1480), (126.736272, 37.615262)),  # B5 호반 1차
    ((2674, 1874), (126.734309, 37.613531)),  # C5 호반 2차
]

# 기준점이 '블록 기호 위치 vs 건물 무게중심' 이라 축척·회전은 맞아도 평행이동이 조금 남는다.
# 도면의 필지 마스크와 카카오 필지 마스크의 겹침을 최대로 하는 값 (tools/_fit2.py 로 측정).
OFFSET_M = (16.0, 3.0)   # 동쪽, 북쪽

MIN_AREA_M2 = 900      # 이보다 작은 조각은 라벨을 달 수도 없다
# 도면에는 색면 위에 글자·기호·필지 경계선이 겹쳐 그려져 있어, 색으로만 따면 테두리가
# 톱니처럼 찢기고 파인다. 크게 닫아 메우고 넉넉히 단순화해야 반듯한 필지가 된다.
SIMPLIFY_M = 7.0
CLOSE_PX = 21
LOT_DEV_M = 7.0     # 필지 변 하나로 묶을 때 허용할 어긋남
LOT_RUN_M = 18.0     # 이보다 짧은 변은 세우지 않는다
LOT_SNAP_DEG = 15.0  # 주방향(또는 그 직각)과 이 안이면 그 각도로 못 박는다
# 구역 경계는 필지 하나가 아니라 지구 전체 윤곽이라 훨씬 크게 다뤄야 반듯해진다
DISTRICT_CLOSE_PX = 95
DISTRICT_DEV_M = 14.0   # 한 직선으로 묶을 때 허용할 어긋남
DISTRICT_RUN_M = 45.0   # 이보다 짧은 직선 구간은 세우지 않는다
DISTRICT_SNAP_DEG = 7.0 # 지구 윤곽은 직각인 데가 적어 조금만 못 박는다          # 기본 닫힘. 공원처럼 더 잘게 끊기는 용지는 CLASSES 에서 따로 준다

# 도면의 블록 기호. 색으로는 못 읽으니(글자다) 도면을 보고 적어 둔다. 인접한 블록은
# 도로 폭이 얇아 폴리곤이 붙어 버려 필지 하나에 코드 하나로 달 수가 없다 - 단지 위에
# 점으로 따로 얹는다.
BLOCKS = [
    ("B1", "그라센트 2차", 126.725939, 37.619748),
    ("B2", "그라센트 1차", 126.728873, 37.618294),
    ("B3", "푸르지오 더마크", 126.732282, 37.617020),
    ("B4", "호반써밋 3차", 126.734466, 37.615561),
    ("B5", "호반써밋 1차", 126.736272, 37.615262),
    ("C5", "호반써밋 2차", 126.734309, 37.613531),
    # 업무시설 획지. 여기 세운 매스는 tools/make_offices.py 가 낸다.
    ("D1", "업무시설", 126.7253161, 37.6184922),
    ("D2", "업무시설", 126.7248629, 37.6179628),
    ("D3", "업무시설", 126.7343953, 37.6126559),
    ("D4", "업무시설", 126.7353542, 37.6122503),
]

# 색면 하나에 필지가 둘인 곳. 중학교와 초등학교는 같은 학교용지 색으로 붙어 있고
# 사이의 필지선이 JPEG 로 뭉개져 색으로는 안 갈린다. 위도로 잘라 나눈다.
#   (근처 lon, lat, 용지, 자를 위도, 북쪽 이름, 남쪽 이름)
SPLIT = [
    (126.73477, 37.61762, "학교", 37.617553, "중학교", "초등학교"),
]

# 도면에 기호로만 적혀 있어 색만으로는 갈리지 않는 것들. 좌표 근처의 그 용지를 고쳐 부른다.
RENAME = [
    # 지구 동쪽 끝 큰 학교용지는 도면에 '대학교 ①' 로 적혀 있고 병원이 함께 들어선다
    (126.7381, 37.61249, 200, "학교", "병원 및 대학"),
    (126.73605, 37.61716, 90, "학교", "유치원"),
    # 지구 서쪽 초등학교(F1)는 학령인구가 줄어 계획이 폐기됐다. 그 땅은 붙어 있는
    # 그라센트 1차 부지로 넘어갔으므로 공동주택용지로 함께 칠한다.
    (126.72794, 37.61822, 120, "학교", "공동주택용지"),
    # 지구 동쪽 수변으로 난 공원은 도면에 '수변공원' 으로 적혀 있다
    (126.73974, 37.61319, 120, "공원", "수변공원"),
    (126.73908, 37.61624, 90, "어린이공원", "소공원"),
    # 그라센트 1차 남단
    (126.72876, 37.61610, 90, "어린이공원", "소공원"),
    # 지구 동쪽 A6·A7 은 필지를 낱개로 팔지 않고 묶어 짓는 블록형 단독이다
    (126.73684, 37.61775, 120, "단독주택용지", "블록형 단독주택용지"),
    (126.73905, 37.61736, 120, "단독주택용지", "블록형 단독주택용지"),
    (126.72605, 37.61786, 90, "종교시설", "사우동성당"),
]

# 도면에는 색면이 있지만 지금 계획에는 없는 것.
DROP = [
    # 동쪽 끝 소공원 아래 학교용지는 폐기됐다
    (126.73863, 37.61585, 90, "학교"),
]

# 색은 범례 스와치가 아니라 '도면 본문'에서 잰 값이다 (tools/_body.py). 스와치는 본문보다
# 어둡게 찍혀 있어 - 공원 범례 (1,127,1) vs 본문 (4,182,4), 광장 (0,127,126) vs (5,186,186) -
# 스와치 색으로 따면 공원·광장·공공공지가 통째로 안 잡힌다.
# 완충녹지와 연결녹지는 사실상 같은 색이라 '녹지'로 묶는다.
# 네 번째 값은 닫힘 크기(px). 공원은 색면 위에 산책로·시설 기호가 그려져 잘게 끊기므로
# 크게 닫고 구멍을 메운다 - 그러지 않으면 83,000 m2 짜리가 6,000 m2 조각들로 나온다.
CLASSES = [
    ("공원", (4, 182, 4), 30, 33),
    ("녹지", (224, 252, 128), 24, CLOSE_PX),
    ("상업용지", (252, 62, 2), 40, CLOSE_PX),
    ("복합용지", (252, 156, 132), 40, CLOSE_PX),
    ("업무용지", (126, 190, 252), 40, CLOSE_PX),
    ("준주거용지", (252, 252, 4), 26, CLOSE_PX),
    ("단독주택용지", (252, 252, 126), 26, CLOSE_PX),
    # 보행자도로 (220,164,4) 와 32 밖에 안 떨어져 있어 넉넉히 잡으면 도로까지 먹는다
    ("공동주택용지", (252, 190, 4), 26, CLOSE_PX),
    # 학교용지는 한 색면 안에 중학교/초등학교가 필지선 하나로 나뉘어 있다. 크게 닫으면
    # 그 선이 메워져 한 덩어리가 되므로 여기만 작게 닫는다.
    ("학교", (4, 252, 252), 40, 3),
    ("광장", (5, 186, 186), 30, CLOSE_PX),
    ("공공공지", (222, 196, 112), 26, CLOSE_PX),
    ("공공청사", (4, 128, 252), 40, CLOSE_PX),
    ("종교시설", (223, 126, 255), 46, CLOSE_PX),
    ("노유자시설", (128, 127, 255), 40, CLOSE_PX),
]

# 같은 색이라 색으로는 못 가르는 것. 공원은 면적으로 근린/어린이를 가른다
# (도시공원법상 어린이공원 최소 1,500 m2, 근린공원은 만 단위로 올라간다).
CHILD_PARK_MAX_M2 = 6000

# 도면에서 지도가 아닌 부분 (좌측 토지이용계획표, 하단 범례) 을 뺀다
EXCLUDE = [(226, 1160, 1192, 2700), (0, 2700, 4768, 3368)]



def ring_area(pts):
    """px 단위 폴리곤 면적. 직선으로 갈아 끼운 결과가 원래 덩어리와 딴판이면 버린다."""
    x, y = pts[:, 1], pts[:, 0]
    return abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))) / 2


def regularize(pts, max_dev, min_run, snap_deg=0.0):
    """계단처럼 꺾인 윤곽을 몇 개의 직선으로 갈아 끼운다.

    색면을 따라 딴 외곽선은 글자·필지선·JPEG 얼룩 때문에 톱니가 난다. 윤곽을 '한
    직선으로 볼 수 있는 구간' 으로 잘라 각 구간에 직선을 맞추고(총최소제곱), 이웃한
    직선끼리 만나는 점을 꼭짓점으로 삼는다 - 진짜 모서리는 남고 계단만 펴진다.

    실제 필지에 둥근 변은 없다. 그래서 직선을 세운 다음, 그 폴리곤이 스스로 가진
    주방향(길이로 가중한 평균)과 거의 나란하거나 직각인 변은 그 각도로 못 박는다 -
    사각형은 진짜 직각 사각형이 되고, 도로를 낀 이웃 필지끼리도 같은 선 위에 선다.
    비스듬한 변(주방향과 snap_deg 넘게 어긋난 것)은 그대로 둔다.

    pts       윤곽 점들 (닫힌 고리, px, 마지막 점은 첫 점과 달라야 한다)
    max_dev   한 직선으로 묶을 때 허용하는 최대 수직 편차 (px)
    min_run   이보다 짧은 구간은 직선으로 세우지 않는다 (px)
    snap_deg  이 각도 안이면 주방향(또는 그 직각)으로 못 박는다. 0 이면 안 한다

    직선으로 못 세우겠으면 None 을 돌려준다. 원본 윤곽을 그대로 돌려주면 부르는 쪽이
    성공으로 착각하고 그 촘촘한 점을 그대로 내보낸다 - 파일이 열 배로 부푼다.
    """
    n = len(pts)
    if n < 8:
        return None

    def fit(i, j):
        seg = pts[np.arange(i, j) % n]
        c = seg.mean(0)
        d = np.linalg.svd(seg - c)[2][0]
        dev = np.abs((seg - c) @ np.array([-d[1], d[0]])).max()
        length = np.linalg.norm(np.diff(seg, axis=0), axis=1).sum()
        return c, d, dev, length

    runs, i, guard = [], 0, 0
    while i < n and guard < 4 * n:
        guard += 1
        j, best = i + 3, None
        while j - i <= n:
            c, d, dev, length = fit(i, j)
            if dev > max_dev:
                break
            best = (c, d, length, j)
            j += 1
        if best is None:
            i += 1
            continue
        runs.append(best)
        i = best[3] - 1

    lines = [(c, d, length) for c, d, length, _ in runs if length >= min_run]
    if len(lines) < 3:
        return None

    if snap_deg > 0:
        # 주방향. 90도 대칭이라 각도를 네 배로 돌려 평균 내야 직각인 변끼리 상쇄되지 않는다
        a = np.array([math.atan2(d[1], d[0]) for _, d, _ in lines])
        w = np.array([length for _, _, length in lines])
        th0 = math.atan2(float((w * np.sin(4 * a)).sum()),
                         float((w * np.cos(4 * a)).sum())) / 4
        out = []
        for c, d, length in lines:
            ang = math.atan2(d[1], d[0])
            best = min((th0 + j * math.pi / 2 for j in range(-2, 3)),
                       key=lambda t: abs((ang - t + math.pi) % (2 * math.pi) - math.pi))
            off = abs((ang - best + math.pi) % (2 * math.pi) - math.pi)
            if math.degrees(off) <= snap_deg:
                d = np.array([math.cos(best), math.sin(best)])
            out.append((c, d, length))
        lines = out
    lines = [(c, d) for c, d, _ in lines]

    out = []
    for (c0, d0), (c1, d1) in zip(lines, lines[1:] + lines[:1]):
        cr = d0[0] * d1[1] - d0[1] * d1[0]
        if abs(cr) < 0.12:      # 거의 나란하면 모서리가 아니다 - 중간에서 잇는다
            out.append((c0 + c1) / 2)
            continue
        w = c1 - c0
        out.append(c0 + d0 * (w[0] * d1[1] - w[1] * d1[0]) / cr)
    out = np.array(out)
    # 거의 나란한 두 직선이 만나는 점은 저 멀리 날아간다 - 그러면 폴리곤에 뿔이 돋는다.
    # 원래 윤곽에서 너무 멀어진 꼭짓점이 하나라도 있으면 통째로 포기한다.
    far = np.sqrt(((out[:, None, :] - pts[None, :, :]) ** 2).sum(2)).min(1).max()
    if far > 4 * max_dev:
        return None
    return out


def fit_transform():
    P = np.array([[p[0], -p[1]] for p, _ in CONTROL], float)
    Q = np.array([[lon * EARTH_C / 180,
                   math.log(math.tan((90 + lat) * math.pi / 360)) * EARTH_C / math.pi]
                  for _, (lon, lat) in CONTROL], float)
    pm, qm = P.mean(0), Q.mean(0)
    X, Y = P - pm, Q - qm
    U, S, Vt = np.linalg.svd(X.T @ Y / len(P))
    R = (U @ Vt).T
    if np.linalg.det(R) < 0:
        R = (U @ np.diag([1, -1]) @ Vt).T
    s = S.sum() / ((X**2).sum() / len(P))
    t = qm - s * (R @ pm)
    res = [float(np.linalg.norm(s * (R @ p) + t - q)) for p, q in zip(P, Q)]
    # 잔차는 보정 전 기준으로 낸다 (기준점 자체가 무게중심이라 보정하면 오히려 커진다)
    t = t + np.array(OFFSET_M) / math.cos(math.radians(37.6165))
    return s, R, t, res


def main() -> None:
    s, R, t, res = fit_transform()
    k = math.cos(math.radians(37.6165))
    print(f"정합: {s * k:.4f} m/px, 회전 {math.degrees(math.atan2(R[1, 0], R[0, 0])):.2f}°, "
          f"잔차 평균 {np.mean(res) * k:.0f} m / 최대 {max(res) * k:.0f} m")

    Rinv = np.linalg.inv(R)

    def from_lonlat(lon, lat):
        mx = lon * EARTH_C / 180
        my = math.log(math.tan((90 + lat) * math.pi / 360)) * EARTH_C / math.pi
        p = Rinv @ (np.array([mx, my]) - t) / s
        return p[0], -p[1]

    def to_lonlat(x, y):
        mx, my = s * (R @ np.array([x, -y])) + t
        return [round(mx * 180 / EARTH_C, 7),
                round(math.degrees(2 * math.atan(math.exp(my * math.pi / EARTH_C)) - math.pi / 2), 7)]

    img = np.asarray(Image.open(SRC).convert("RGB")).astype(np.int16)
    ok = np.ones(img.shape[:2], bool)
    for x0, y0, x1, y1 in EXCLUDE:
        ok[y0:y1, x0:x1] = False

    ppm = 1 / (s * k)          # px per metre
    feats, union = [], np.zeros(img.shape[:2], bool)
    stat = [0, 0]
    stat = [0, 0]
    for name, rgb, tol, close in CLASSES:
        m = (np.abs(img - np.array(rgb)).max(2) <= tol) & ok
        m = ndi.binary_opening(m, np.ones((7, 7)))
        m = ndi.binary_closing(m, np.ones((close, close)))
        m = ndi.binary_fill_holes(m)
        union |= m
        lab, n = ndi.label(m)
        # 색으로 안 갈리는 붙은 필지를 미리 쪼갠다. 라벨을 새로 매기지 않고 마스크에
        # 한 줄을 지워서 끊으면 그 뒤 흐름은 그대로다.
        for lon, lat, use, cut, _, _ in SPLIT:
            if use != name:
                continue
            row = int(round(from_lonlat(lon, cut)[1]))
            col = int(round(from_lonlat(lon, cut)[0]))
            for i in range(1, n + 1):
                ys, xs = np.nonzero(lab == i)
                if not len(ys) or not (ys.min() < row < ys.max()):
                    continue
                if not (xs.min() - 40 < col < xs.max() + 40):
                    continue
                m[max(row - 1, 0):row + 2, xs.min():xs.max() + 1] = False
        lab, n = ndi.label(m)
        kept = 0
        for i in range(1, n + 1):
            blob = lab == i
            area = blob.sum() / ppm**2
            if area < MIN_AREA_M2:
                continue
            pad = np.pad(blob, 1)
            cs = measure.find_contours(pad.astype(float), 0.5)
            if not cs:
                continue
            raw = max(cs, key=len)
            c = measure.approximate_polygon(raw, SIMPLIFY_M * ppm * 0.5)
            if len(c) < 4:
                continue
            # 필지는 사각형이면 사각형, 삼각형이면 삼각형이다. 색으로 딴 톱니를 직선으로
            # 갈아 끼워 변이 곧게 떨어지게 한다. 직선 맞춤은 촘촘한 원본 윤곽에 해야
            # 한다 - 이미 솎아 낸 점들에 하면 엉뚱한 데서 만나 뿔이 돋는다.
            reg = regularize(raw[:-1], LOT_DEV_M * ppm, LOT_RUN_M * ppm, LOT_SNAP_DEG)
            if reg is not None and abs(ring_area(reg) / max(blob.sum(), 1) - 1) < 0.25:
                c = np.vstack([reg, reg[:1]])
                stat[0] += 1
            else:
                stat[1] += 1
            ring = [to_lonlat(c[j][1] - 1, c[j][0] - 1) for j in range(len(c) - 1)]
            ys, xs = np.nonzero(blob)
            use = "어린이공원" if name == "공원" and area <= CHILD_PARK_MAX_M2 else name
            feats.append({
                "type": "Feature",
                "properties": {"use": use, "area": round(area),
                               "at": to_lonlat(xs.mean(), ys.mean())},
                "geometry": {"type": "Polygon", "coordinates": [ring + [ring[0]]]},
            })
            kept += 1
        if kept:
            print(f"  {name:12s} {kept:3d}개")

    print(f"  직선화 {stat[0]}개 / 원본 유지 {stat[1]}개")

    # 구역 경계: 용지 전체를 도로 폭만큼 닫고 그 외곽선.
    # 용지 사이 도로·녹지 틈이 그대로 남으면 테두리가 안으로 파여 들쭉날쭉해진다.
    # 크게 닫아 메우고, 닫으면서 생긴 잔가지는 다시 열어 떨군 뒤 넉넉히 단순화한다.
    d = ndi.binary_closing(union, np.ones((DISTRICT_CLOSE_PX, DISTRICT_CLOSE_PX)))
    d = ndi.binary_fill_holes(d)
    d = ndi.binary_opening(d, np.ones((25, 25)))
    lab, n = ndi.label(d)
    big = max(range(1, n + 1), key=lambda i: (lab == i).sum())
    pad = np.pad(lab == big, 1)
    raw = max(measure.find_contours(pad.astype(float), 0.5), key=len)
    c = regularize(raw[:-1], DISTRICT_DEV_M * ppm, DISTRICT_RUN_M * ppm, DISTRICT_SNAP_DEG)
    if c is None:
        c = measure.approximate_polygon(raw, DISTRICT_DEV_M * ppm * 0.5)[:-1]
    c = np.vstack([c, c[:1]])
    outline = [to_lonlat(c[j][1] - 1, c[j][0] - 1) for j in range(len(c) - 1)]
    feats.insert(0, {
        "type": "Feature",
        "properties": {"use": "도시개발구역", "area": round((lab == big).sum() / ppm**2)},
        "geometry": {"type": "Polygon", "coordinates": [outline + [outline[0]]]},
    })

    for lon, lat, use, cut, north, south in SPLIT:
        for f in feats:
            at = f["properties"].get("at")
            if not at or f["properties"]["use"] != use:
                continue
            if math.hypot((at[0] - lon) * 111320 * k, (at[1] - lat) * 110540) > 100:
                continue
            f["properties"]["use"] = north if at[1] > cut else south
            print(f"  쪼갬 {use} -> {f['properties']['use']} {f['properties']['area']} m2")

    for lon, lat, rad, use in DROP:
        gone = [f for f in feats
                if f["properties"].get("at") and f["properties"]["use"] == use
                and math.hypot((f["properties"]["at"][0] - lon) * 111320 * k,
                               (f["properties"]["at"][1] - lat) * 110540) <= rad]
        for f in gone:
            feats.remove(f)
        print(f"  뺌 {use}: {len(gone)}개")

    for lon, lat, rad, was, now in RENAME:
        hit = 0
        for f in feats:
            at = f["properties"].get("at")
            if not at or f["properties"]["use"] != was:
                continue
            dx = (at[0] - lon) * 111320 * k
            dy = (at[1] - lat) * 110540
            if math.hypot(dx, dy) <= rad:
                f["properties"]["use"] = now
                hit += 1
        print(f"  이름 고침 {was} -> {now}: {hit}개")

    for code, label, lon, lat in BLOCKS:
        feats.append({
            "type": "Feature",
            "properties": {"block": code, "name": label},
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
        })

    # 표준 GeoJSON 키만 둔다. 여분 키가 있으면 maplibre 의 geojson 소스가 로드를
    # 끝내지 못하고 조용히 멈춘다 (에러도 안 난다).
    doc = {"type": "FeatureCollection", "features": feats}
    json.dump(doc, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(f"{os.path.relpath(OUT, ROOT)}  구역 1 + 용지 {len(feats) - 1}  "
          f"{os.path.getsize(OUT) / 1e3:.0f} KB")


if __name__ == "__main__":
    main()
