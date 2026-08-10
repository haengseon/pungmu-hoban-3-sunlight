# -*- coding: utf-8 -*-
"""도면 본문에서 실제로 쓰인 색면을 센다. 범례 스와치는 본문보다 어둡게 찍혀 있어
그대로 쓰면 공원·광장처럼 아예 안 잡히는 용지가 생긴다."""
import io, sys
from collections import Counter
import numpy as np
from PIL import Image
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.path.insert(0, 'tools')
from make_landuse import EXCLUDE

im = np.asarray(Image.open('asset/ground/계획도1.jpg').convert('RGB')).astype(np.int16)
ok = np.ones(im.shape[:2], bool)
for x0, y0, x1, y1 in EXCLUDE:
    ok[y0:y1, x0:x1] = False
ok[2700:, :] = False
q = (im // 8 * 8 + 4)[ok]
mx, mn = q.max(1), q.min(1)
q = q[(mx - mn > 40) | (mx < 200)]          # 회색·흰 바탕 제외
c = Counter(map(tuple, q))
for col, n in c.most_common(30):
    if n < 8000:
        break
    print('(%3d,%3d,%3d)  %8d px' % (*col, n))
