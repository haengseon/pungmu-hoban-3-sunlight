# -*- coding: utf-8 -*-
import io, json, sys
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
d = json.load(open('web/public/landuse.json', encoding='utf-8'))
rows, tot = [], 0
for f in d['features']:
    p = f['properties']
    if p['use'] == '공원':
        tot += p['area']
        rows.append((p['area'], p.get('at')))
rows.sort(reverse=True)
for a, at in rows:
    print('%7d m2  %s' % (a, at))
print('합계 %d m2   (토지이용계획표 83,133 m2)' % tot)
