# -*- coding: utf-8 -*-
"""낸 폴리곤을 카카오 캡처 위에 그려 모양만 본다."""
import io, json, math, sys
from PIL import Image, ImageDraw
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
D = 'C:/Users/hsc81/AppData/Local/Temp/claude/D--workspace-hoban2/b769362f-1785-4a91-95b2-93725a639249/'
EC = 20037508.342789244
km = json.load(open('tools/out/kakao_wide.json'))
lu = json.load(open('web/public/landuse.json', encoding='utf-8'))
im = Image.open('tools/out/kakao_wide.png').convert('RGB')
d = ImageDraw.Draw(im, 'RGBA')


def px(lon, lat):
    mx = lon * EC / 180
    my = math.log(math.tan((90 + lat) * math.pi / 360)) * EC / math.pi
    return (km['ox'] + (mx - km['mA']['x']) * km['sx'],
            km['oy'] + (my - km['mA']['y']) * km['sy'])


for f in lu['features']:
    if f['geometry']['type'] != 'Polygon':
        continue
    pts = [px(*p) for p in f['geometry']['coordinates'][0]]
    if f['properties']['use'] == '도시개발구역':
        d.line(pts, fill=(220, 0, 0, 255), width=6)
    else:
        d.polygon(pts, outline=(20, 60, 200, 255), fill=(60, 110, 240, 60))
im.resize((im.width // 2, im.height // 2)).save(D + 'shapes.png')
print('ok')
