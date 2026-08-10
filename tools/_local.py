# -*- coding: utf-8 -*-
"""정합 오차가 자리마다 다른지 본다.

한 덩어리(축척·회전·평행이동)로는 안 맞는다면, 스캔 도면이 국소적으로 일그러졌다는
뜻이다. 여러 창에서 국소 평행이동을 따로 재서 그 분포를 본다.
"""
import io, json, math, sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.path.insert(0, 'tools')
import make_landuse as ml

K = math.cos(math.radians(37.6165))
km = json.load(open('tools/out/kakao_wide.json'))
ki = np.asarray(Image.open('tools/out/kakao_wide.png').convert('RGB')).astype(np.int16)
H, W = ki.shape[:2]
kmask = np.zeros((H, W), bool)
for c in ([244, 237, 225], [240, 232, 216]):
    kmask |= np.abs(ki - np.array(c)).max(2) <= 5
kmask = ndi.binary_fill_holes(ndi.binary_closing(kmask, np.ones((9, 9))))

LOTS = {'공동주택용지', '상업용지', '복합용지', '업무용지', '준주거용지',
        '단독주택용지', '학교', '공공청사', '종교시설', '노유자시설', '공공공지'}
img = np.asarray(Image.open(ml.SRC).convert('RGB')).astype(np.int16)
ok = np.ones(img.shape[:2], bool); ok[2700:, :] = False
for x0, y0, x1, y1 in ml.EXCLUDE:
    ok[y0:y1, x0:x1] = False
dmask = np.zeros(img.shape[:2], bool)
for name, rgb, tol, close in ml.CLASSES:
    if name not in LOTS:
        continue
    m = (np.abs(img - np.array(rgb)).max(2) <= tol) & ok
    dmask |= ndi.binary_closing(ndi.binary_opening(m, np.ones((7, 7))), np.ones((close, close)))
dmask = ndi.binary_fill_holes(dmask)
DH, DW = dmask.shape
s0, R0, t0, _ = ml.fit_transform()
t0 = t0 - np.array(ml.OFFSET_M) / K
Rinv = np.linalg.inv(R0)

# 단지·용지가 실제로 그려진 자리들
SITES = [
    ('B1 그라센트2', 126.72594, 37.61975), ('B2 그라센트1', 126.72887, 37.61829),
    ('B3 더마크', 126.73228, 37.61702), ('B4 호반3차', 126.73447, 37.61556),
    ('B5 호반1차', 126.73627, 37.61526), ('C5 호반2차', 126.73431, 37.61353),
    ('지구 북단', 126.72700, 37.62060), ('지구 동단', 126.73850, 37.61450),
]
EC = ml.EARTH_C
R_M = 190.0     # 창 반지름
STEP = 2


def merc(lon, lat):
    return np.array([lon * EC / 180,
                     math.log(math.tan((90 + lat) * math.pi / 360)) * EC / math.pi])


offs = []
for name, lon, lat in SITES:
    c = merc(lon, lat)
    cx = km['ox'] + (c[0] - km['mA']['x']) * km['sx']
    cy = km['oy'] + (c[1] - km['mA']['y']) * km['sy']
    r = int(R_M / K * km['sx'])
    y0, y1 = max(int(cy) - r, 0), min(int(cy) + r, H)
    x0, x1 = max(int(cx) - r, 0), min(int(cx) + r, W)
    B = kmask[y0:y1:STEP, x0:x1:STEP]
    if B.sum() < 500:
        print('%-12s 카카오 필지 없음' % name); continue
    gy, gx = np.mgrid[y0:y1:STEP, x0:x1:STEP]
    Q = np.stack([(km['mA']['x'] + (gx - km['ox']) / km['sx']).ravel(),
                  (km['mA']['y'] + (gy - km['oy']) / km['sy']).ravel()], 1)
    best = (-1, 0, 0)
    for dx in np.arange(-45, 45.1, 1.5):
        for dy in np.arange(-45, 45.1, 1.5):
            P = (Q - t0 - np.array([dx, dy]) / K) @ Rinv.T / s0
            px = np.round(P[:, 0]).astype(np.int32)
            py = np.round(-P[:, 1]).astype(np.int32)
            v = np.zeros(len(px), bool)
            g = (px >= 0) & (px < DW) & (py >= 0) & (py < DH)
            v[g] = dmask[py[g], px[g]]
            A = v.reshape(B.shape)
            sc = (A & B).sum() / max((A | B).sum(), 1)
            if sc > best[0]:
                best = (sc, dx, dy)
    offs.append((name, lon, lat, best[1], best[2], best[0]))
    print('%-12s dx %+6.1f m  dy %+6.1f m   IoU %.3f' % (name, best[1], best[2], best[0]))

if len(offs) >= 3:
    d = np.array([[o[3], o[4]] for o in offs])
    print('\n평균 (%+.1f, %+.1f) m,  표준편차 (%.1f, %.1f) m' %
          (*d.mean(0), *d.std(0)))
