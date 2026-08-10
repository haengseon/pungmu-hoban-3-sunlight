"""Turn the Kakao trace capture into the 3D scene's ground texture.

브이월드 기본지도는 이 신축 단지를 아직 그리지 않는다 - 필지 경계만 있고 동이 없으며,
항공영상은 개발 이전 밭이다. 카카오는 4개 단지 건물을 전부 그리므로, 푸트프린트를 뽑을
때 이미 찍어 두는 그 캡처를 그대로 지면에 깔아 쓴다.

입력은 tools/trace_kakao.mjs 의 산출물이다. 그 캡처의 affine 은 회전 없는 메르카토르
정렬이라, 이미지 네 모서리의 좌표가 역변환 한 번으로 정확히 떨어진다.

    python tools/make_ground.py

    -> web/public/ground.webp        지면 텍스처
       web/src/data/ground.json      MapLibre image 소스가 쓸 네 모서리 좌표
"""
from __future__ import annotations

import json
import math
import os

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NAME = os.environ.get("NAME", "kakao_wide")
TRACE_PNG = os.path.join(ROOT, "tools", "out", f"{NAME}.png")
TRACE_JSON = os.path.join(ROOT, "tools", "out", f"{NAME}.json")
STEM = os.environ.get("OUT", "ground")
OUT_IMG = os.path.join(ROOT, "web", "public", f"{STEM}.webp")
OUT_META = os.path.join(ROOT, "web", "src", "data", f"{STEM}.json")

EARTH_C = 20037508.342789244
QUALITY = 82
# 가장자리를 알파로 흐려 브이월드에 녹인다. 안 그러면 줌아웃했을 때 캡처 범위가
# 직사각형으로 딱 잘려 보인다. 카카오와 브이월드는 색조도 달라서 경계가 더 튄다.
FEATHER_M = 70

# 광역 캡처는 2 px/m(줌 17에서 1:1) 다. 5500x3700 을 그대로 쓰면 5.6 MB 라 절반으로
# 줄여 1 px/m 로 깐다 - 배경이라 이 정도면 충분하고 앱은 그만큼 가벼워진다.
SCALE = float(os.environ.get("SCALE", 0.5))


def to_lonlat(mx: float, my: float) -> list[float]:
    """Web Mercator metres -> WGS84"""
    lon = mx * 180.0 / EARTH_C
    lat = math.degrees(2 * math.atan(math.exp(my * math.pi / EARTH_C)) - math.pi / 2)
    return [round(lon, 9), round(lat, 9)]


def feather(size: tuple[int, int], px: int) -> Image.Image:
    """가장자리 px 만큼 0 -> 255 로 올라가는 알파 마스크"""
    w, h = size
    if px <= 0:
        return Image.new("L", size, 255)
    ramp = np.minimum(np.arange(max(w, h)) / px, 1.0)
    # 양쪽 끝에서 각각 램프를 적용하고, 두 축 중 더 어두운 쪽을 택한다
    ax = np.minimum(ramp[:w], ramp[:w][::-1])
    ay = np.minimum(ramp[:h], ramp[:h][::-1])
    mask = np.minimum(ax[None, :], ay[:, None])
    return Image.fromarray((mask * 255).astype(np.uint8), "L")


def main() -> None:
    for path in (TRACE_PNG, TRACE_JSON):
        if not os.path.exists(path):
            raise SystemExit(
                f"{path} 가 없다. 개발 서버를 띄우고 `node tools/trace_kakao.mjs` 를 먼저 돌려라")

    meta = json.load(open(TRACE_JSON, encoding="utf-8"))
    img = Image.open(TRACE_PNG).convert("RGB")
    w, h = img.size

    # px -> mercator, 캡처 affine 의 역변환
    def merc(px: float, py: float) -> tuple[float, float]:
        return (meta["mA"]["x"] + (px - meta["ox"]) / meta["sx"],
                meta["mA"]["y"] + (py - meta["oy"]) / meta["sy"])

    # MapLibre image 소스의 순서: 좌상 -> 우상 -> 우하 -> 좌하
    corners = [to_lonlat(*merc(*p)) for p in ((0, 0), (w, 0), (w, h), (0, h))]

    if SCALE != 1.0:
        img = img.resize((round(w * SCALE), round(h * SCALE)), Image.LANCZOS)

    img.putalpha(feather(img.size, round(FEATHER_M * meta["pxPerMetre"] * SCALE)))

    os.makedirs(os.path.dirname(OUT_IMG), exist_ok=True)
    img.save(OUT_IMG, "WEBP", quality=QUALITY, method=6)

    json.dump(
        {
            "coordinates": corners,
            "pxPerMetre": round(meta["pxPerMetre"] * SCALE, 4),
            "size": list(img.size),
            "source": "카카오맵 렌더 캡처 (tools/trace_kakao.mjs, level 1)",
        },
        open(OUT_META, "w", encoding="utf-8"),
        ensure_ascii=False,
        indent=1,
    )

    span_m = (w / meta["pxPerMetre"], h / meta["pxPerMetre"])
    print(f"{os.path.relpath(OUT_IMG, ROOT)}  {img.size[0]}x{img.size[1]} px  "
          f"{os.path.getsize(OUT_IMG) / 1e6:.2f} MB  "
          f"({span_m[0]:.0f} x {span_m[1]:.0f} m)")
    print(f"{os.path.relpath(OUT_META, ROOT)}  모서리 {corners[0]} .. {corners[2]}")


if __name__ == "__main__":
    main()
