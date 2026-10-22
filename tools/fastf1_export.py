# -*- coding: utf-8 -*-
"""
FastF1 → RL Yarış Laboratuvarı tur telemetrisi (CSV) dışa aktarıcı
=====================================================================

Gerçek bir F1 turunun telemetrisini (mesafe, hız, gaz, fren, vites, devir, DRS, zaman) indirir ve
uygulamanın 3B tekrar ekranındaki "Karşılaştırma → CSV içe aktar…" seçeneğinin okuduğu biçimde kaydeder.
Böylece yapay zekânın sürüşünü istediğin pilotun herhangi bir turuyla üst üste koyup delta zaman grafiğini,
sektör/mini sektör tablolarını ve hayalet aracı görebilirsin.

Bu betik KENDİ bilgisayarında çalışır (uygulama bunu çalıştırmaz). Veri, FastF1 kütüphanesi aracılığıyla
F1 canlı zamanlama arşivinden indirilir; ilk indirme birkaç dakika sürebilir, sonra önbellekten gelir.

Kurulum (Windows 11, bir kez):
    py -m pip install fastf1

Kullanım örnekleri (PowerShell ya da Komut İstemi, proje klasöründe):
    py tools\\fastf1_export.py --yil 2024 --etkinlik Monza --oturum Q --surucu LEC
    py tools\\fastf1_export.py --yil 2025 --etkinlik "Italian Grand Prix" --oturum R --surucu NOR --tur 53
    py tools\\fastf1_export.py --yil 2023 --etkinlik 10 --oturum Q --surucu VER --cikti ver_silverstone.csv
    py tools\\fastf1_export.py --yil 2024 --etkinlik Austin --oturum Q --surucu HAM --ayirici noktali
    py tools\\fastf1_export.py --yil 2024 --etkinlik Spa --oturum Q --liste      (sürücülerin en hızlı turlarını listeler)

Seçenekler:
    --yil        Sezon (ör. 2024)
    --etkinlik   Yarış haftasonu: ad ("Monza", "Italian Grand Prix") ya da takvimdeki sıra numarası
    --oturum     FP1, FP2, FP3, SQ (sprint sıralama), S (sprint), Q (sıralama), R (yarış). Varsayılan: Q
    --surucu     Üç harfli kısaltma (LEC, VER, NOR…) ya da yarış numarası (16, 1, 4…)
    --tur        Tur numarası. Verilmezse sürücünün o oturumdaki EN HIZLI turu seçilir
    --cikti      Çıktı dosyası. Varsayılan: <yil>_<etkinlik>_<oturum>_<surucu>_tur<n>.csv
    --ayirici    virgul (varsayılan; ondalık nokta) ya da noktali (Türkçe Excel: noktalı virgül + ondalık virgül)
    --onbellek   FastF1 önbellek klasörü. Varsayılan: kullanıcı klasöründe .fastf1_onbellek
    --liste      Dosya yazmadan, oturumdaki sürücülerin en hızlı turlarını göster

Çıktı biçimi (uygulamanın içe aktarıcısıyla birebir uyumlu):
    # surucu: LEC                       ← '#' ile başlayan satırlar üst bilgidir (etiket ve tur süresi için)
    # yil: 2024
    # etkinlik: Italian Grand Prix
    # oturum: Q
    # tur: 18
    # tur_suresi_s: 79.327
    # tur_mesafesi_m: 5770.2
    # kaynak: FastF1 / F1 canlı zamanlama verisi
    mesafe_m,hiz_kmh,gaz_yuzde,fren,vites,devir_rpm,drs,zaman_s
    0.0,312.0,100,0,8,11512,0,0.000
    ...

Uygulamada: 3B tekrarı aç → alt çubuktaki "Karşılaştırma" listesinden "CSV içe aktar…" → bu dosyayı seç.
Mesafe, pist uzunluğuna oranla eşlenir (gerçek pist ile simülasyon pisti arasındaki küçük uzunluk farkı sorun olmaz).
İçe aktarıcı İngilizce başlıkları da tanır (Distance, Speed, Throttle, Brake, nGear, RPM, DRS, Time).

Lisans notu: FastF1 MIT lisanslıdır; zamanlama verisinin hakları Formula 1'e aittir — yalnızca kişisel analiz için kullan.
"""

import argparse
import math
import os
import re
import sys

COLUMNS = ['mesafe_m', 'hiz_kmh', 'gaz_yuzde', 'fren', 'vites', 'devir_rpm', 'drs', 'zaman_s']


def _num(v, nd):
    """Sayıyı yaz; NaN/None ise boş bırak."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return ''
    if math.isnan(f) or math.isinf(f):
        return ''
    s = f'{f:.{nd}f}'
    if nd > 0:
        s = s.rstrip('0').rstrip('.') or '0'
    return s


def write_lap_csv(path, rows, meta, separator='virgul'):
    """rows: [{'mesafe_m':…, 'hiz_kmh':…, …}] → uygulamanın içe aktardığı CSV.
    separator: 'virgul' (',' ve ondalık nokta) ya da 'noktali' (';' ve ondalık virgül — Türkçe Excel)."""
    tr = separator == 'noktali'
    sep = ';' if tr else ','
    digits = {'mesafe_m': 2, 'hiz_kmh': 1, 'gaz_yuzde': 1, 'fren': 0, 'vites': 0, 'devir_rpm': 0, 'drs': 0, 'zaman_s': 3}
    lines = [f'# {k}: {v}' for k, v in meta.items() if v not in (None, '')]
    lines.append(sep.join(COLUMNS))
    for r in rows:
        cells = []
        for c in COLUMNS:
            s = _num(r.get(c), digits[c])
            if tr:
                s = s.replace('.', ',')
            cells.append(s)
        lines.append(sep.join(cells))
    # BOM: Excel UTF-8'i doğru tanısın (uygulama BOM'u yok sayar)
    with open(path, 'w', encoding='utf-8-sig', newline='') as f:
        f.write('\r\n'.join(lines) + '\r\n')
    return len(rows)


def _safe(s):
    s = str(s)
    tr = str.maketrans('ğüşöçıİĞÜŞÖÇ', 'gusociIGUSOC')
    s = s.translate(tr)
    return re.sub(r'[^A-Za-z0-9]+', '-', s).strip('-').lower() or 'etkinlik'


def _pick_driver(laps, drv):
    fn = getattr(laps, 'pick_drivers', None) or getattr(laps, 'pick_driver')
    return fn(drv)


def _lap_telemetry(lap):
    """Tur telemetrisi: konum verisiyle birleştirilmiş (daha sık örnek) ya da yalnız araç verisi + mesafe."""
    try:
        tel = lap.get_telemetry()
        if 'Distance' not in tel.columns:
            tel = tel.add_distance()
    except Exception:  # eski sürümler / eksik konum verisi
        tel = lap.get_car_data().add_distance()
    return tel


def lap_rows(tel):
    rows = []
    t0 = None
    for _, r in tel.iterrows():
        t = r.get('Time')
        ts = t.total_seconds() if hasattr(t, 'total_seconds') else float('nan')
        if t0 is None and not math.isnan(ts):
            t0 = ts
        d = float(r.get('Distance', float('nan')))
        brake = r.get('Brake')
        drs = r.get('DRS')
        thr = r.get('Throttle')
        try:
            thr = max(0.0, min(100.0, float(thr)))
        except (TypeError, ValueError):
            thr = float('nan')
        try:
            drs_open = 1 if int(drs) in (10, 12, 14) else 0  # F1 DRS kodları: 10/12/14 = açık
        except (TypeError, ValueError):
            drs_open = 0
        rows.append({
            'mesafe_m': max(0.0, d) if not math.isnan(d) else float('nan'),
            'hiz_kmh': r.get('Speed'),
            'gaz_yuzde': thr,
            'fren': 1 if bool(brake) and str(brake).lower() not in ('false', '0', 'nan') else 0,
            'vites': r.get('nGear'),
            'devir_rpm': r.get('RPM'),
            'drs': drs_open,
            'zaman_s': ts - t0 if t0 is not None and not math.isnan(ts) else float('nan'),
        })
    # mesafe artan olsun (konum birleştirmesinde nadiren geri sıçrar)
    out, last = [], -1.0
    for r in rows:
        d = r['mesafe_m']
        if isinstance(d, float) and math.isnan(d):
            continue
        if d > last:
            out.append(r)
            last = d
    return out


def main(argv=None):
    p = argparse.ArgumentParser(description='FastF1 tur telemetrisini RL Yarış Laboratuvarı CSV biçimine aktarır.')
    p.add_argument('--yil', type=int, required=True)
    p.add_argument('--etkinlik', required=True, help='ad ("Monza") ya da takvim sırası (14)')
    p.add_argument('--oturum', default='Q', help='FP1, FP2, FP3, SQ, S, Q, R (varsayılan Q)')
    p.add_argument('--surucu', help='LEC, VER, NOR… ya da yarış numarası')
    p.add_argument('--tur', type=int, help='tur numarası (varsayılan: en hızlı tur)')
    p.add_argument('--cikti', help='çıktı CSV dosyası')
    p.add_argument('--ayirici', choices=['virgul', 'noktali'], default='virgul')
    p.add_argument('--onbellek', help='FastF1 önbellek klasörü')
    p.add_argument('--liste', action='store_true', help='sürücülerin en hızlı turlarını listele')
    a = p.parse_args(argv)

    try:
        import fastf1
    except ImportError:
        print('fastf1 kurulu değil. Kurmak için:  py -m pip install fastf1', file=sys.stderr)
        return 1

    cache = a.onbellek or os.path.join(os.path.expanduser('~'), '.fastf1_onbellek')
    os.makedirs(cache, exist_ok=True)
    fastf1.Cache.enable_cache(cache)

    event = int(a.etkinlik) if str(a.etkinlik).isdigit() else a.etkinlik
    print(f'Oturum yükleniyor: {a.yil} · {a.etkinlik} · {a.oturum} (ilk seferde birkaç dakika sürebilir)…')
    session = fastf1.get_session(a.yil, event, a.oturum)
    session.load(laps=True, telemetry=True, weather=False, messages=False)
    ev_name = session.event.get('EventName', str(a.etkinlik)) if hasattr(session, 'event') else str(a.etkinlik)

    if a.liste or not a.surucu:
        print(f'\n{ev_name} {a.yil} · {a.oturum} — en hızlı turlar:')
        best = []
        for drv in session.laps['Driver'].dropna().unique():
            try:
                lp = _pick_driver(session.laps, drv).pick_fastest()
                if lp is not None and hasattr(lp['LapTime'], 'total_seconds'):
                    best.append((lp['LapTime'].total_seconds(), drv, int(lp['LapNumber'])))
            except Exception:
                pass
        for sec, drv, n in sorted(best):
            print(f'  {drv:4s} tur {n:3d}  {int(sec // 60)}:{sec % 60:06.3f}')
        if not a.surucu:
            print('\nBir sürücü seçmek için --surucu kullan (ör. --surucu LEC).')
        return 0

    laps = _pick_driver(session.laps, a.surucu)
    if laps is None or len(laps) == 0:
        print(f'Sürücü bulunamadı: {a.surucu}. --liste ile oturumdaki sürücülere bak.', file=sys.stderr)
        return 2
    if a.tur:
        sel = laps[laps['LapNumber'] == a.tur]
        if len(sel) == 0:
            print(f'{a.surucu} için {a.tur}. tur yok. Mevcut turlar: {sorted(int(x) for x in laps["LapNumber"].dropna())}', file=sys.stderr)
            return 3
        lap = sel.iloc[0]
    else:
        lap = laps.pick_fastest()
        if lap is None:
            print('Geçerli en hızlı tur bulunamadı; --tur ile tur numarası ver.', file=sys.stderr)
            return 3

    tel = _lap_telemetry(lap)
    rows = lap_rows(tel)
    if len(rows) < 20:
        print('Telemetri çok kısa ya da eksik.', file=sys.stderr)
        return 4

    lt = lap['LapTime']
    lap_sec = lt.total_seconds() if hasattr(lt, 'total_seconds') else None
    lap_no = int(lap['LapNumber'])
    drv = str(lap['Driver'])
    meta = {
        'surucu': drv,
        'yil': a.yil,
        'etkinlik': ev_name,
        'oturum': a.oturum,
        'tur': lap_no,
        'tur_suresi_s': f'{lap_sec:.3f}' if lap_sec and not math.isnan(lap_sec) else '',
        'tur_mesafesi_m': f'{rows[-1]["mesafe_m"]:.1f}',
        'kaynak': 'FastF1 / F1 canlı zamanlama verisi',
    }
    out = a.cikti or f'{a.yil}_{_safe(ev_name)}_{_safe(a.oturum)}_{_safe(drv)}_tur{lap_no}.csv'
    n = write_lap_csv(out, rows, meta, a.ayirici)
    t = f'{int(lap_sec // 60)}:{lap_sec % 60:06.3f}' if lap_sec else '?'
    print(f'\nKaydedildi: {os.path.abspath(out)}')
    print(f'  {drv} · {ev_name} {a.yil} · {a.oturum} · tur {lap_no} · {t} · {n} satır · {rows[-1]["mesafe_m"]:.0f} m')
    print('Uygulamada: 3B tekrar → Karşılaştırma → "CSV içe aktar…" ile bu dosyayı seç.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
