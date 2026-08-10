# -*- coding: utf-8 -*-
"""도면 필지 마스크를 카카오 필지 마스크에 겹쳐, 정합의 축척·회전·평행이동을 다시 잡는다.

기준점 6개(블록 기호 <-> 건물 무게중심)로 맞춘 변환은 기준점 자체가 서로 다른 것을
가리키고 있어 잔차가 18 m 다. 여기서는 '카카오가 그린 필지 경계'와 '도면의 색면 경계'
라는 같은 것끼리 겹쳐 4개 값(dx, dy, 축척비, 회전)을 직접 찾는다.

    python tools/_fit2.py
"""
import io, json, math, sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.path.insert(0, 'tools')
import make_landuse as ml

STEP = 6
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
ok = np.ones(img.shape[:2], bool)
ok[2700:, :] = False
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
t0 = t0 - np.array(ml.OFFSET_M) / K     # 이 스크립트가 찾는 값이 곧 OFFSET_M 이라 되돌린다

# 볼 곳: 카카오가 필지를 그린 자리 둘레만. 나대지가 점수를 먹으면 최적점이 흐려진다.
ys, xs = np.nonzero(kmask)
y0b, y1b = max(ys.min() - 80, 0), min(ys.max() + 80, H)
x0b, x1b = max(xs.min() - 80, 0), min(xs.max() + 80, W)
gy, gx = np.mgrid[y0b:y1b:STEP, x0b:x1b:STEP]
B = kmask[y0b:y1b:STEP, x0b:x1b:STEP]
ROI = ndi.binary_dilation(B, np.ones((21, 21)))
mx = km['mA']['x'] + (gx - km['ox']) / km['sx']
my = km['mA']['y'] + (gy - km['oy']) / km['sy']
Q = np.stack([mx.ravel(), my.ravel()], 1)
print('격자 %d점 (카카오 %.3f m/px, 표본 간격 %.1f m)'
      % (Q.shape[0], 1 / km['sx'] * K, STEP / km['sx'] * K))


def score(dx, dy, ds, dth):
    th = math.radians(dth)
    c, sn = math.cos(th), math.sin(th)
    R = np.array([[c, -sn], [sn, c]]) @ R0
    Rinv = np.linalg.inv(R)
    t = t0 + np.array([dx, dy]) / K
    P = (Q - t) @ Rinv.T / (s0 * ds)
    px = np.round(P[:, 0]).astype(np.int32)
    py = np.round(-P[:, 1]).astype(np.int32)
    v = np.zeros(len(px), bool)
    g = (px >= 0) & (px < DW) & (py >= 0) & (py < DH)
    v[g] = dmask[py[g], px[g]]
    A = v.reshape(gx.shape) & ROI
    return (A & B).sum() / max((A | B).sum(), 1)


best = (score(0, 0, 1, 0), 0.0, 0.0, 1.0, 0.0)
print('보정 없음 IoU %.4f' % best[0])
GRIDS = [
    (np.arange(-40, 41, 8), np.arange(-40, 41, 8),
     np.arange(0.985, 1.0151, 0.005), np.arange(-0.6, 0.61, 0.2)),
    (np.arange(-8, 8.1, 2), np.arange(-8, 8.1, 2),
     np.arange(-0.004, 0.0041, 0.002), np.arange(-0.15, 0.151, 0.05)),
    (np.arange(-2, 2.1, 0.5), np.arange(-2, 2.1, 0.5),
     np.arange(-0.001, 0.0011, 0.0005), np.arange(-0.04, 0.041, 0.02)),
]
for i, (DX, DY, DS, DT) in enumerate(GRIDS):
    b = best
    for dx in DX + b[1]:
        for dy in DY + b[2]:
            for ds in (DS if i == 0 else DS + b[3]):
                for dth in DT + b[4]:
                    v = score(dx, dy, ds, dth)
                    if v > best[0]:
                        best = (v, dx, dy, ds, dth)
    print('  %d단계  dx=%.2f dy=%.2f 축척x%.4f 회전%+.3f°  IoU %.4f'
          % (i + 1, best[1], best[2], best[3], best[4], best[0]))

v, dx, dy, ds, dth = best
print('\nOFFSET_M = (%.1f, %.1f)' % (dx, dy))
print('SCALE_ADJ = %.5f      # %.4f -> %.4f m/px' % (ds, s0 * K, s0 * ds * K))
print('ROT_ADJ_DEG = %.3f' % dth)
