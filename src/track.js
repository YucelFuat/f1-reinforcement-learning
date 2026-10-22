// Pist: kontrol noktalarından kapalı spline, eşit aralıklı merkez çizgisi,
// ve O(1) sorgu için önceden hesaplanmış iki ızgara:
//   sdf  : duvara olan işaretli mesafe (pozitif = pist içi)
//   sgrid: merkez çizgisi üzerindeki yay uzunluğu (ilerleme ölçümü)

import { RNG } from './rng.js';
import { REAL_TRACK_DEFS } from './tracks/real.js';

const DS = 4;          // merkez çizgisi örnekleme aralığı (px)
const CELL = 3;        // ızgara hücre boyu (px)

// Austin (Circuit of the Americas) – resmi pist haritasındaki siyah çizgiden otomatik izlenen merkez çizgisi
// (görsel koordinatları; 1 görsel pikseli ≈ 1.67 m, izlenen uzunluk 5.51 km ile birebir uyumlu).
const AUSTIN_RAW = [
  [114.8, 830], [122.1, 831.7], [129.4, 833.4], [136.7, 835], [144, 836.7], [151.3, 838.3], [158.7, 840], [166, 841.6], [173.3, 843.3], [180.6, 845],
  [187.9, 846.6], [195.2, 848.3], [202.6, 849.9], [209.9, 851.6], [217.2, 853.3], [224.5, 854.9], [231.8, 856.6], [239.1, 858.3], [246.4, 860], [253.7, 861.6],
  [261.1, 863.3], [268.4, 865], [275.7, 866.7], [283, 868.4], [290.3, 870.1], [297.6, 871.7], [304.9, 873.4], [312.2, 875.1], [319.5, 876.8], [326.9, 878.5],
  [334.2, 880.1], [341.5, 881.8], [348.8, 883.5], [356.1, 885.1], [363.4, 886.8], [370.7, 888.4], [378, 890.1], [385.4, 891.6], [392.8, 892.8], [400.2, 894],
  [407.6, 895.3], [414.9, 896.9], [422.2, 898.5], [429.6, 900.1], [436.9, 901.7], [444.3, 903.2], [451.6, 904.6], [459, 906.1], [466.1, 908.2], [473.1, 911],
  [480.1, 913.4], [487.3, 914.2], [494.6, 912.9], [501.2, 909.8], [506.3, 904.8], [508, 898.3], [506, 891.7], [501.1, 886.3], [495.6, 881.3], [490.2, 876.1],
  [484.8, 870.9], [479.4, 865.7], [473.9, 860.5], [468.6, 855.3], [463.3, 850], [458, 844.7], [452.6, 839.5], [447.2, 834.2], [442, 828.8], [437.2, 823.1],
  [433, 816.9], [429.5, 810.3], [426.9, 803.3], [425.1, 796], [424.1, 788.6], [424, 781.2], [424.7, 773.7], [426.2, 766.4], [428.3, 759.2], [431.1, 752.3],
  [434.6, 745.6], [438.4, 739.2], [442.5, 732.9], [446.5, 726.6], [450.6, 720.3], [454.6, 714], [458.7, 707.6], [462.7, 701.3], [466.8, 695], [470.9, 688.7],
  [475, 682.4], [479, 676.1], [483, 669.8], [486.9, 663.3], [490.3, 656.7], [493.2, 649.8], [495, 642.6], [495.6, 635.2], [495.1, 627.7], [494.1, 620.3],
  [493.4, 612.9], [493.6, 605.4], [494.8, 598], [497.1, 590.9], [500.3, 584.2], [504.5, 578], [509.3, 572.3], [514.2, 566.6], [518.9, 560.8], [522.7, 554.4],
  [525.2, 547.4], [526.1, 540.1], [525.6, 532.6], [524.2, 525.3], [522.2, 518.1], [519.7, 511], [517.4, 503.9], [515.9, 496.6], [515.5, 489.1], [516.3, 481.7],
  [518, 474.4], [520.4, 467.4], [523.5, 460.6], [527.2, 454], [531.3, 447.8], [535.9, 441.9], [541.1, 436.5], [547, 431.9], [553.5, 428.3], [560.5, 425.7],
  [567.8, 424.1], [575.2, 423.3], [582.7, 423], [590.2, 422.8], [597.7, 422.8], [605.2, 422.7], [612.7, 422.5], [620.2, 422.5], [627.6, 422.1], [634.9, 420.7],
  [641.4, 417.5], [646.8, 412.4], [651, 406.3], [654.6, 399.7], [657.6, 392.9], [660.2, 385.8], [662.5, 378.7], [664.4, 371.4], [665.8, 364.1], [667.2, 356.7],
  [669.3, 349.6], [673, 343.3], [678.1, 337.8], [684.1, 333.5], [690.9, 330.7], [698.2, 329.8], [705.6, 330.5], [712.7, 332.5], [719.4, 335.8], [725.8, 339.5],
  [732.7, 341.9], [739.7, 341.3], [746.2, 338], [752.2, 333.5], [758.1, 328.9], [764.1, 324.4], [770.1, 319.9], [776, 315.3], [781.9, 310.7], [787.9, 306.1],
  [793.7, 301.4], [799.6, 296.7], [805.4, 292], [811.3, 287.3], [817.1, 282.6], [822.8, 277.7], [828, 272.4], [832.3, 266.3], [835.2, 259.5], [837.2, 252.3],
  [838.9, 245], [840.6, 237.7], [842.3, 230.4], [844, 223.1], [845.6, 215.8], [847.3, 208.4], [849, 201.1], [850.7, 193.8], [852.4, 186.5], [854.1, 179.2],
  [855.9, 171.9], [857.6, 164.6], [859.4, 157.4], [861.3, 150.1], [863.1, 142.8], [865, 135.5], [866.8, 128.3], [868.5, 121], [870.3, 113.7], [872, 106.4],
  [873.8, 99.1], [875.5, 91.8], [877.2, 84.5], [878.7, 77.1], [880.1, 69.8], [881.7, 62.4], [883.5, 55.2], [885, 47.9], [884.7, 40.8], [881.2, 34.9],
  [875.2, 31.9], [868.6, 33.2], [862.9, 37.6], [857.5, 42.8], [852.1, 48], [846.7, 53.2], [841.3, 58.4], [835.9, 63.6], [830.5, 68.8], [825.1, 74.1],
  [819.8, 79.3], [814.4, 84.6], [809, 89.8], [803.6, 95], [798.3, 100.3], [792.9, 105.5], [787.4, 110.6], [781.9, 115.7], [776.4, 120.8], [770.9, 125.8],
  [765.3, 130.9], [759.7, 135.9], [754.1, 140.8], [748.5, 145.8], [742.8, 150.7], [737.1, 155.6], [731.3, 160.4], [725.6, 165.2], [719.8, 170.1], [714.1, 174.9],
  [708.4, 179.7], [702.6, 184.6], [696.9, 189.4], [691.1, 194.2], [685.3, 198.9], [679.5, 203.7], [673.7, 208.4], [667.9, 213.1], [662.1, 217.9], [656.2, 222.6],
  [650.4, 227.3], [644.5, 232], [638.6, 236.6], [632.7, 241.2], [626.8, 245.8], [620.8, 250.4], [614.9, 254.9], [608.8, 259.4], [602.8, 263.8], [596.7, 268.3],
  [590.7, 272.7], [584.6, 277.1], [578.6, 281.5], [572.5, 285.9], [566.4, 290.3], [560.3, 294.7], [554.2, 299], [548, 303.3], [541.9, 307.6], [535.8, 312],
  [529.6, 316.3], [523.5, 320.6], [517.3, 324.8], [511.1, 329], [504.9, 333.2], [498.7, 337.5], [492.5, 341.8], [486.4, 346.1], [480.2, 350.3], [474, 354.5],
  [467.7, 358.6], [461.4, 362.7], [455.1, 366.7], [448.8, 370.8], [442.4, 374.8], [436.1, 378.7], [429.7, 382.6], [423.3, 386.6], [416.9, 390.5], [410.5, 394.5],
  [404.2, 398.4], [397.8, 402.4], [391.4, 406.4], [385.1, 410.4], [378.7, 414.4], [372.4, 418.4], [366.1, 422.4], [359.7, 426.4], [353.4, 430.5], [347.1, 434.6],
  [340.9, 438.7], [334.7, 443], [328.5, 447.1], [322.1, 451.1], [316.3, 455.6], [312.9, 461.4], [314.1, 467.3], [319.4, 471.5], [326.1, 474.9], [332.9, 477.9],
  [339.7, 481], [346.3, 484.5], [352.9, 488.3], [359.4, 492], [365.9, 495.7], [372.4, 499.4], [378.9, 503.2], [385.3, 507.1], [391.6, 511.1], [397.9, 515.2],
  [404.2, 519.2], [410.2, 523.7], [415, 529.1], [417.1, 535.7], [415.5, 542.4], [410.7, 547.7], [404.3, 551.3], [397.4, 554.1], [390.4, 556.8], [383.3, 559.3],
  [376, 560.5], [368.8, 559.8], [362.1, 556.9], [356.1, 552.4], [350.5, 547.4], [344.8, 542.6], [338.7, 538.3], [332.2, 534.6], [325.4, 531.5], [318.4, 528.6],
  [311.4, 526.2], [304.1, 524.8], [296.7, 525], [289.4, 526.6], [282.4, 529.1], [276, 532.5], [272.1, 537.8], [273, 544], [277.7, 549.3], [283.6, 553.7],
  [290, 557.8], [296.3, 561.7], [302.5, 565.9], [308.7, 570.2], [314.9, 574.5], [321, 578.8], [327.2, 583.1], [333.4, 587.2], [339.6, 591.4], [345.9, 595.6],
  [352, 599.9], [358, 604.3], [363.8, 609.1], [368.9, 614.6], [373, 620.7], [375.9, 627.6], [377.8, 634.8], [378.9, 642.2], [379.7, 649.7], [379.9, 657.1],
  [379.3, 664.6], [377.7, 671.8], [374.8, 678.7], [370.8, 685], [366.3, 691], [361.6, 696.8], [356.8, 702.6], [352, 708.4], [347, 713.9], [341.5, 719],
  [335.4, 723.1], [328.6, 726.2], [321.4, 728.5], [314.2, 730.4], [306.8, 731.7], [299.4, 732.7], [291.9, 733], [284.4, 732.7], [277, 731.6], [269.8, 729.8],
  [262.8, 727.1], [256.1, 723.7], [249.6, 720], [243.2, 716.2], [236.7, 712.4], [230.1, 708.8], [223.5, 705.2], [216.9, 701.7], [210.2, 698.3], [203.5, 694.9],
  [196.8, 691.6], [190.1, 688.3], [183.3, 684.9], [176.6, 681.7], [169.8, 678.5], [162.9, 675.7], [155.7, 674.1], [148.6, 675], [142, 678.3], [136.3, 683],
  [131, 688.3], [126, 693.9], [121.3, 699.7], [116.7, 705.7], [112.1, 711.6], [107.4, 717.5], [102.8, 723.3], [98.1, 729.2], [93.3, 735], [88.5, 740.8],
  [83.8, 746.5], [78.9, 752.3], [74.1, 758], [69.1, 763.6], [64, 769.1], [58.6, 774.4], [53.4, 779.7], [48.2, 785.1], [43.4, 790.8], [39.9, 797.2],
  [39.2, 804.1], [42.1, 810.5], [47.7, 814.8], [54.6, 817.3], [61.9, 818.9], [69.3, 820.4], [76.6, 821.9], [84, 823.4], [91.3, 825], [98.7, 826.5],
  [106, 828], [113.3, 829.7],
];
const AUSTIN_SCALE = 3.4;
// Resmi COTA yükseklik grafiğinden: [tur oranı (0-1), rakım (m)]. Viraj noktaları pist üzerindeki konumlarına eşlendi.
const AUSTIN_ELEV = [
  [0, 130.9], [0.0529, 130.9], [0.0684, 135.3], [0.0839, 144.2], [0.0995, 152.1], [0.1212, 157.4], [0.1339, 153],
  [0.1488, 144.2], [0.1674, 138.4], [0.1957, 139.7], [0.2221, 140.6], [0.2339, 139.3], [0.2521, 138.9], [0.2679, 137.5],
  [0.2907, 139.3], [0.3144, 140.6], [0.3289, 142.4], [0.3401, 144.6], [0.3584, 149.5], [0.3796, 151.7], [0.4009, 148.6],
  [0.4171, 142.8], [0.435, 139.3], [0.4529, 139.7], [0.4753, 142.4], [0.4948, 137.1], [0.5143, 134.4], [0.5485, 138],
  [0.5826, 135.8], [0.6313, 135.8], [0.6703, 134.9], [0.6928, 132.7], [0.7124, 134.9], [0.7339, 137.1], [0.7471, 136.2],
  [0.7747, 133.6], [0.784, 134.9], [0.806, 136.7], [0.8308, 138.4], [0.8508, 137.1], [0.8691, 134.9], [0.8946, 132.7],
  [0.922, 131.8], [0.9374, 128.7], [0.9498, 126.5], [0.9629, 128.7], [0.9732, 130.9], [1, 130.9],
];
// Kurgusal pistlerin ölçeği (metre / piksel)
export const DEFAULT_MPP = 0.22;

export const TRACK_DEFS = [
  {
    id: 'oval',
    name: 'Oval (Kolay)',
    halfWidth: 46,
    points: [
      [1000, 250], [1600, 250], [1850, 450], [1850, 750], [1600, 950],
      [400, 950], [150, 750], [150, 450], [400, 250],
    ],
  },
  {
    id: 'kidney',
    name: 'Böbrek (Orta)',
    halfWidth: 42,
    points: [
      [900, 1100], [1500, 1100], [1850, 950], [1900, 650], [1700, 380],
      [1350, 300], [1150, 480], [950, 620], [700, 470], [520, 230],
      [250, 280], [130, 600], [250, 950], [500, 1100],
    ],
  },
  {
    id: 'technical',
    name: 'Teknik (Zor)',
    halfWidth: 38,
    points: [
      [700, 1150], [1250, 1150], [1600, 1100], [1800, 900], [1650, 720],
      [1400, 760], [1250, 600], [1400, 420], [1680, 400], [1840, 330], [1860, 190],
      [1700, 95], [1100, 120], [900, 300], [1000, 520], [820, 700],
      [560, 560], [500, 300], [280, 200], [120, 420], [180, 800],
      [130, 1050], [350, 1160],
    ],
  },
  {
    id: 'gp',
    name: 'Grand Prix (Uzun)',
    halfWidth: 40,
    points: [
      [900, 1200], [1700, 1200], [2050, 1150], [2200, 950], [2050, 800],
      [1750, 820], [1550, 700], [1600, 480], [1900, 420], [2150, 300],
      [2050, 110], [1500, 100], [1150, 160], [1000, 380], [1150, 560],
      [1050, 760], [780, 760], [620, 560], [700, 330], [500, 140],
      [220, 200], [120, 500], [300, 760], [200, 1000], [400, 1190],
    ],
  },
  {
    id: 'austin',
    name: 'Austin – COTA (Gerçek düzen)',
    halfWidth: 15,          // ≈ 14.5 m pist genişliği
    lengthMeters: 5513,     // gerçek tur uzunluğu → ölçek buradan hesaplanır
    realRecord: { time: '1:36.169', note: 'Leclerc, 2019 yarış en hızlı turu' },
    elevation: AUSTIN_ELEV,
    points: AUSTIN_RAW.map(([x, y]) => [x * AUSTIN_SCALE, y * AUSTIN_SCALE]),
  },
  ...REAL_TRACK_DEFS,
];

// Merkezcil Catmull-Rom (kıvrılma/düğüm oluşturmaz)
function catmullRomClosed(P, samples = 20) {
  const out = [];
  const n = P.length;
  const alpha = 0.5;
  const tj = (ti, a, b) => ti + Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), alpha) + 1e-6;
  for (let i = 0; i < n; i++) {
    const p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n], p3 = P[(i + 2) % n];
    const t0 = 0, t1 = tj(t0, p0, p1), t2 = tj(t1, p1, p2), t3 = tj(t2, p2, p3);
    for (let k = 0; k < samples; k++) {
      const t = t1 + ((t2 - t1) * k) / samples;
      const pt = [0, 0];
      for (let d = 0; d < 2; d++) {
        const A1 = ((t1 - t) / (t1 - t0)) * p0[d] + ((t - t0) / (t1 - t0)) * p1[d];
        const A2 = ((t2 - t) / (t2 - t1)) * p1[d] + ((t - t1) / (t2 - t1)) * p2[d];
        const A3 = ((t3 - t) / (t3 - t2)) * p2[d] + ((t - t2) / (t3 - t2)) * p3[d];
        const B1 = ((t2 - t) / (t2 - t0)) * A1 + ((t - t0) / (t2 - t0)) * A2;
        const B2 = ((t3 - t) / (t3 - t1)) * A2 + ((t - t1) / (t3 - t1)) * A3;
        pt[d] = ((t2 - t) / (t2 - t1)) * B1 + ((t - t1) / (t2 - t1)) * B2;
      }
      out.push(pt);
    }
  }
  return out;
}

function resampleClosed(pts, step) {
  const n = pts.length;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const total = cum[n];
  const m = Math.max(16, Math.round(total / step));
  const ds = total / m;
  const xs = new Float32Array(m), ys = new Float32Array(m);
  let seg = 0;
  for (let k = 0; k < m; k++) {
    const s = k * ds;
    while (cum[seg + 1] < s) seg++;
    const a = pts[seg], b = pts[(seg + 1) % n];
    const len = cum[seg + 1] - cum[seg] || 1;
    const t = (s - cum[seg]) / len;
    xs[k] = a[0] + (b[0] - a[0]) * t;
    ys[k] = a[1] + (b[1] - a[1]) * t;
  }
  return { xs, ys, ds, total };
}

function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

export class Track {
  constructor(def) {
    this.id = def.id;
    this.name = def.name;
    this.halfWidth = def.halfWidth;
    this.controlPoints = def.points.map((p) => [p[0], p[1]]);

    const dense = catmullRomClosed(this.controlPoints, 24);
    const { xs, ys, ds, total } = resampleClosed(dense, DS);
    this.cx = xs;
    this.cy = ys;
    this.n = xs.length;
    this.ds = ds;
    this.length = total;

    const n = this.n;
    this.tan = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      this.tan[i] = Math.atan2(ys[b] - ys[a], xs[b] - xs[a]);
    }
    // ölçek: metre / piksel
    this.mpp = def.lengthMeters ? def.lengthMeters / total : def.mpp || DEFAULT_MPP;
    this.lengthMeters = total * this.mpp;
    this.realRecord = def.realRecord || null;
    this._buildElevation(def.elevation);
    this._analyze(def);

    this.startX = xs[0];
    this.startY = ys[0];
    this.startAngle = this.tan[0];

    this._buildGrid();
  }

  // Yükseklik (m) ve eğim (dh/ds) dizileri. Profil yoksa pist düzdür.
  _buildElevation(profile) {
    const n = this.n;
    const raw = new Float32Array(n);
    this.hasElevation = !!(profile && profile.length > 1);
    if (this.hasElevation) {
      let j = 0;
      for (let i = 0; i < n; i++) {
        const f = i / n;
        while (j < profile.length - 2 && profile[j + 1][0] < f) j++;
        const [f0, h0] = profile[j], [f1, h1] = profile[j + 1];
        const t = f1 > f0 ? Math.min(1, Math.max(0, (f - f0) / (f1 - f0))) : 0;
        // yumuşak geçiş (kosinüs)
        const u = (1 - Math.cos(t * Math.PI)) / 2;
        raw[i] = h0 + (h1 - h0) * u;
      }
    }
    // hafif yumuşatma (≈ ±25 m)
    const w = Math.max(1, Math.round(25 / (this.ds * this.mpp)));
    const elev = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = -w; k <= w; k++) sum += raw[(i + k + n) % n];
      elev[i] = sum / (2 * w + 1);
    }
    const base = this.hasElevation ? Math.min(...elev) : 0;
    for (let i = 0; i < n; i++) elev[i] -= base; // en alçak nokta = 0
    this.elevBase = base;
    this.elev = elev;
    this.grade = new Float32Array(n);
    const dsm = this.ds * this.mpp;
    for (let i = 0; i < n; i++) this.grade[i] = (elev[(i + 1) % n] - elev[(i - 1 + n) % n]) / (2 * dsm);
  }

  // Eğrilik, viraj listesi, sonraki viraj tabloları, DRS bölgeleri ve sektörler
  _analyze(def) {
    const n = this.n, dsm = this.ds * this.mpp, tan = this.tan;
    const k = Math.max(1, Math.round(10 / dsm));
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) raw[i] = wrapAngle(tan[(i + k) % n] - tan[(i - k + n) % n]) / (2 * k * dsm);
    const curv = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = -k; j <= k; j++) sum += raw[(i + j + n) % n];
      curv[i] = sum / (2 * k + 1);
    }
    this.curv = curv; // 1/m, işaretli (+ = açı artan yöne dönüş)

    // virajlar: |eğrilik| yerel tepe noktaları (yarıçap < 350 m), 60 m'den yakın olanlar birleşir
    const W = Math.max(2, Math.round(40 / dsm));
    let corners = [];
    for (let i = 0; i < n; i++) {
      const a = Math.abs(curv[i]);
      if (a < 1 / 350) continue;
      let isMax = true;
      for (let j = -W; j <= W && isMax; j++) {
        if (!j) continue;
        const b = Math.abs(curv[(i + j + n) % n]);
        if (b > a || (b === a && j < 0)) isMax = false;
      }
      if (isMax) corners.push({ i, k: curv[i] });
    }
    const minSep = Math.round(60 / dsm);
    corners.sort((a, b) => a.i - b.i);
    const merged = [];
    for (const c of corners) {
      const last = merged[merged.length - 1];
      if (last && c.i - last.i < minSep && Math.sign(c.k) === Math.sign(last.k)) {
        if (Math.abs(c.k) > Math.abs(last.k)) merged[merged.length - 1] = c;
      } else merged.push(c);
    }
    if (merged.length > 1) {
      const f = merged[0], l = merged[merged.length - 1];
      if (f.i + n - l.i < minSep && Math.sign(f.k) === Math.sign(l.k)) {
        if (Math.abs(l.k) > Math.abs(f.k)) merged[0] = l;
        merged.pop();
        merged.sort((a, b) => a.i - b.i);
      }
    }
    this.corners = merged.map((c, idx) => ({ no: idx + 1, i: c.i, s: c.i * this.ds, k: c.k, radius: 1 / Math.abs(c.k) }));
    // her örnek için sonraki viraj tepe noktası
    this.ncDist = new Float32Array(n).fill(1e4);
    this.ncK = new Float32Array(n);
    const C = this.corners;
    if (C.length) {
      let p = 0;
      for (let i = 0; i < n; i++) {
        while (p < C.length && C[p].i < i) p++;
        const c = p < C.length ? C[p] : C[0];
        const ci = p < C.length ? c.i : c.i + n;
        this.ncDist[i] = (ci - i) * dsm;
        this.ncK[i] = c.k;
      }
    }

    // DRS bölgeleri: en uzun iki düzlük (yarıçap > 600 m, ≥ 350 m)
    const straight = new Uint8Array(n);
    for (let i = 0; i < n; i++) straight[i] = Math.abs(curv[i]) < 1 / 600 ? 1 : 0;
    const gapFill = Math.round(40 / dsm);
    // kısa kıvrımları doldur
    for (let i = 0; i < n; i++) {
      if (straight[i]) continue;
      let a = 1, b = 1;
      while (a <= gapFill && !straight[(i - a + n) % n]) a++;
      while (b <= gapFill && !straight[(i + b) % n]) b++;
      if (a + b - 1 <= gapFill) straight[i] = 2;
    }
    const runs = [];
    let st = -1;
    for (let i = 0; i < n; i++) if (!straight[i]) { st = i; break; }
    if (st >= 0) {
      let cur = null;
      for (let q = 1; q <= n; q++) {
        const i = (st + q) % n;
        if (straight[i]) {
          if (!cur) cur = { a: st + q, len: 0 };
          cur.len++;
        } else if (cur) {
          runs.push(cur);
          cur = null;
        }
      }
      if (cur) runs.push(cur);
    }
    runs.sort((a, b) => b.len - a.len);
    this.drsZones = [];
    this.drsZoneAt = new Int8Array(n).fill(-1);
    for (const r of runs.slice(0, 2)) {
      if (r.len * dsm < 350) continue;
      const a = r.a + Math.round(90 / dsm), b = r.a + r.len - Math.round(20 / dsm);
      if (b - a < 10) continue;
      const z = this.drsZones.length;
      this.drsZones.push({ s0: (a % n) * this.ds, s1: (b % n) * this.ds, lengthM: (b - a) * dsm });
      for (let j = a; j < b; j++) this.drsZoneAt[j % n] = z;
    }

    // sektörler (tur oranı); gerçek pistlerde tanımdan gelebilir
    const sf = def.sectors && def.sectors.length === 2 ? def.sectors : [1 / 3, 2 / 3];
    this.sectorFrac = [sf[0], sf[1], 1];
    this.miniSectors = 24;
  }

  // Basit kütle-nokta hız profili (m/s, her örnek için). Rastgele başlangıçta "güvenli" giriş hızı için.
  speedProfile(P) {
    const key = [P.mass, P.power, P.cda, P.cla, P.mu].join();
    if (this._spKey === key) return this._sp;
    const n = this.n, dsm = this.ds * this.mpp, g = 9.81;
    const kA = (0.5 * 1.2) / P.mass;
    const vmax = 100;
    const vc = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const c = Math.abs(this.curv[i]);
      const den = c - P.mu * kA * P.cla;
      vc[i] = den <= 0 ? vmax : Math.min(vmax, Math.sqrt((P.mu * g) / den));
    }
    const fw = Float32Array.from(vc), bw = Float32Array.from(vc);
    for (let pass = 0; pass < 2; pass++) {
      for (let q = 0; q < n; q++) {
        const i = q, j = (i - 1 + n) % n;
        const va = fw[j];
        const a = Math.min((P.power * 1000) / (P.mass * Math.max(va, 5)), 0.6 * P.mu * (g + kA * P.cla * va * va)) - kA * P.cda * va * va;
        const vi = Math.sqrt(Math.max(0, va * va + 2 * a * dsm));
        if (vi < fw[i]) fw[i] = vi;
      }
      for (let q = n - 1; q >= 0; q--) {
        const i = q, j = (i + 1) % n;
        const vb = bw[j];
        const a = P.mu * (g + kA * P.cla * vb * vb) + kA * P.cda * vb * vb;
        const vi = Math.sqrt(vb * vb + 2 * a * dsm);
        if (vi < bw[i]) bw[i] = vi;
      }
    }
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = Math.min(fw[i], bw[i]);
    this._spKey = key;
    this._sp = v;
    return v;
  }

  idxAt(s) {
    let i = Math.floor(s / this.ds) % this.n;
    if (i < 0) i += this.n;
    return i;
  }

  elevAt(s) {
    let i = Math.floor(s / this.ds) % this.n;
    if (i < 0) i += this.n;
    return this.elev[i];
  }

  _buildGrid() {
    const hw = this.halfWidth;
    const margin = hw + 36;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < this.n; i++) {
      minX = Math.min(minX, this.cx[i]); maxX = Math.max(maxX, this.cx[i]);
      minY = Math.min(minY, this.cy[i]); maxY = Math.max(maxY, this.cy[i]);
    }
    minX -= margin + 60; minY -= margin + 60; maxX += margin + 60; maxY += margin + 60;
    this.bounds = { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
    this.ox = minX;
    this.oy = minY;
    this.cell = CELL;
    this.inv = 1 / CELL;
    const gw = (this.gw = Math.ceil((maxX - minX) / CELL) + 1);
    const gh = (this.gh = Math.ceil((maxY - minY) / CELL) + 1);
    const dist = new Float32Array(gw * gh).fill(1e9);
    const sg = new Float32Array(gw * gh);

    const n = this.n, xs = this.cx, ys = this.cy, ds = this.ds;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = xs[i], ay = ys[i], bx = xs[j], by = ys[j];
      const vx = bx - ax, vy = by - ay;
      const len2 = vx * vx + vy * vy || 1;
      const x0 = Math.max(0, Math.floor((Math.min(ax, bx) - margin - minX) / CELL));
      const x1 = Math.min(gw - 1, Math.ceil((Math.max(ax, bx) + margin - minX) / CELL));
      const y0 = Math.max(0, Math.floor((Math.min(ay, by) - margin - minY) / CELL));
      const y1 = Math.min(gh - 1, Math.ceil((Math.max(ay, by) + margin - minY) / CELL));
      for (let gy = y0; gy <= y1; gy++) {
        const py = minY + (gy + 0.5) * CELL;
        const row = gy * gw;
        for (let gx = x0; gx <= x1; gx++) {
          const px = minX + (gx + 0.5) * CELL;
          let t = ((px - ax) * vx + (py - ay) * vy) / len2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const dx = ax + vx * t - px, dy = ay + vy * t - py;
          const d = Math.sqrt(dx * dx + dy * dy);
          const k = row + gx;
          if (d < dist[k]) {
            dist[k] = d;
            sg[k] = (i + t) * ds;
          }
        }
      }
    }
    const sdf = new Float32Array(gw * gh);
    for (let k = 0; k < sdf.length; k++) sdf[k] = dist[k] > 1e8 ? -500 : hw - dist[k];
    this.sdf = sdf;
    this.sgrid = sg;
  }

  // Duvara işaretli mesafe (pozitif: pist içinde)
  sdfAt(x, y) {
    const fx = (x - this.ox) * this.inv, fy = (y - this.oy) * this.inv;
    if (fx < 0 || fy < 0 || fx >= this.gw || fy >= this.gh) return -500;
    return this.sdf[(fy | 0) * this.gw + (fx | 0)];
  }

  // Merkez çizgisi üzerindeki yay uzunluğu
  sAt(x, y) {
    const fx = (x - this.ox) * this.inv, fy = (y - this.oy) * this.inv;
    if (fx < 0 || fy < 0 || fx >= this.gw || fy >= this.gh) return 0;
    return this.sgrid[(fy | 0) * this.gw + (fx | 0)];
  }

  tangentAt(s) {
    let i = Math.floor(s / this.ds) % this.n;
    if (i < 0) i += this.n;
    return this.tan[i];
  }

  pointAt(s) {
    let i = Math.floor(s / this.ds) % this.n;
    if (i < 0) i += this.n;
    return [this.cx[i], this.cy[i]];
  }

  // Pistin kendisiyle çakışıp çakışmadığını ve virajların yeterince geniş olduğunu kontrol eder
  validate() {
    const n = this.n, hw = this.halfWidth;
    const xs = this.cx, ys = this.cy;
    let minRadius = Infinity;
    for (let i = 0; i < n; i++) {
      const a = this.tan[(i - 2 + n) % n], b = this.tan[(i + 2) % n];
      const dth = Math.abs(wrapAngle(b - a));
      const r = (4 * this.ds) / Math.max(dth, 1e-6);
      if (r < minRadius) minRadius = r;
    }
    const arcSkip = Math.ceil((hw * 4.2) / this.ds);
    const need = 2 * hw + 26;
    let minGap = Infinity;
    for (let i = 0; i < n; i += 2) {
      for (let j = i + arcSkip; j < n; j += 2) {
        const circ = Math.min(j - i, n - (j - i));
        if (circ < arcSkip) continue;
        const d = Math.hypot(xs[i] - xs[j], ys[i] - ys[j]);
        if (d < minGap) minGap = d;
      }
    }
    const ok = minRadius >= hw * 1.0 && minGap >= need;
    return { ok, minRadius, minGap, need, length: this.length };
  }

  toJSON() {
    return { id: this.id, name: this.name, halfWidth: this.halfWidth, points: this.controlPoints, mpp: this.mpp, lengthMeters: this.lengthMeters };
  }
}

// Kutupsal yöntemle rastgele, kendisiyle kesişmeyen pist üretir
export function randomTrackDef(seed) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const rng = new RNG(seed + attempt * 7919);
    const k = 9 + rng.int(7);
    const hw = 38 + rng.int(8);
    const cx = 1000, cy = 650;
    let radii = [];
    for (let i = 0; i < k; i++) radii.push(0.45 + 0.55 * rng.next());
    // yumuşatma
    radii = radii.map((r, i) => (r * 2 + radii[(i + 1) % k] + radii[(i - 1 + k) % k]) / 4);
    const pts = [];
    for (let i = 0; i < k; i++) {
      const ang = (i / k) * Math.PI * 2 + rng.range(-0.18, 0.18) * (Math.PI * 2 / k);
      const r = radii[i];
      pts.push([cx + Math.cos(ang) * r * 900, cy + Math.sin(ang) * r * 560]);
    }
    const def = { id: 'random-' + seed, name: 'Rastgele #' + seed, halfWidth: hw, points: pts };
    const t = new Track(def);
    if (t.validate().ok) return def;
  }
  return TRACK_DEFS[0];
}

export function makeTrack(def) {
  return new Track(def);
}
