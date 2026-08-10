"""파이프라인이 잘못 뽑은 푸트프린트를 사람이 확인한 값으로 바로잡는다.

    python tools/fix_footprints.py

buildings.json 은 build_data.py -> refine_footprints.py 가 만든다. 그런데 그 두
스크립트의 좌표(NOT_BUILDING, DONG_ANCHOR)는 **특정 캡처의 픽셀 좌표**라 캡처를 다시
찍으면 통째로 어긋난다. 그래서 개별 동을 고칠 때 파이프라인을 다시 돌리지 않고 결과에
직접 손을 댄다. 여기 적힌 것만 바뀌고, 다시 돌려도 같은 결과가 나온다.

같은 평면을 쓰는 동은 **원본 동의 외곽선을 옮겨** 쓴다. 카카오가 동 번호 라벨로
가려 놓은 동(더마크 301·302)은 인접 블록을 흡수해 뚱뚱해지는데, 형제 동을 복사하는
편이 래스터를 다시 다듬는 것보다 정확하고 되짚기도 쉽다.
"""
from __future__ import annotations

import json
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH = os.path.join(ROOT, "web", "src", "data", "buildings.json")

# (단지, 고칠 동, 베낄 동) - 같은 주택형이라 평면이 같은 짝
COPY_PLAN = [
    # 301동은 304·311 과 같은 크기여야 하는데 379 m2 로 나왔다 (304=265, 311=288).
    # 카카오가 동 라벨로 가려 DONG_ANCHOR 로 처리한 동이라 옆 블록을 흡수했다.
    ("prugio", "301", "304"),
]


def centroid(poly):
    return (sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly))


def area_m2(poly, lat):
    a = 0.0
    for i in range(len(poly)):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % len(poly)]
        a += x0 * y1 - x1 * y0
    return abs(a) / 2 * 111320**2 * math.cos(math.radians(lat))


def main() -> None:
    doc = json.load(open(PATH, encoding="utf-8"))
    by_id = {c["id"]: c for c in doc["complexes"]}
    changed = 0

    for cid, dst, src in COPY_PLAN:
        c = by_id.get(cid)
        if not c:
            print(f"  {cid} 없음")
            continue
        dsts = [b for b in c["buildings"] if b["dong"] == dst]
        srcs = [b for b in c["buildings"] if b["dong"] == src]
        if len(dsts) != 1 or len(srcs) != 1:
            print(f"  {cid} {dst}<-{src}: 볼륨이 하나씩이 아니라 건너뛴다")
            continue
        d, s = dsts[0], srcs[0]
        before = area_m2(d["poly"], doc["origin"]["lat"])
        dc, sc = centroid(d["poly"]), centroid(s["poly"])
        d["poly"] = [[round(x - sc[0] + dc[0], 7), round(y - sc[1] + dc[1], 7)]
                     for x, y in s["poly"]]
        after = area_m2(d["poly"], doc["origin"]["lat"])
        print(f"  {cid} {dst}동 <- {src}동 평면 : {before:.0f} -> {after:.0f} m2")
        changed += 1

    if changed:
        json.dump(doc, open(PATH, "w", encoding="utf-8"),
                  ensure_ascii=False, separators=(",", ":"))
    print(f"{os.path.relpath(PATH, ROOT)}  {changed}건 수정")


if __name__ == "__main__":
    main()
