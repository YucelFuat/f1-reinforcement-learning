// Varsayılan ayarlar. UI bu nesneleri canlı olarak değiştirir.

export const TICK_RATE = 60; // 1x hızda saniyedeki simülasyon adımı

export const GRAVITY = 9.81;
export const AIR_DENSITY = 1.2;
export const V_REF = 95; // m/s, gözlem normalizasyonu (≈ 340 km/s)

// Araç fiziği önayarları (SI birimleri).
// 'f1': 2019-2025 dönemi F1 aracına yakın değerler: 798 kg (pilot dahil, yakıtsız), ~750 kW (ICE + ERS),
// CdA ≈ 1.45 m² (sürükleme), ClA ≈ 4.4 m² (yere basma), lastik μ ≈ 1.7.
// İki akslı model: ağırlık/aero dengesi, boylamsal + yanal yük transferi ve lastik yük hassasiyeti
// → ağır frenle viraja girişte (trail braking) ve yavaş viraj çıkışında tam gazda arka kayar (oversteer),
// hızlı virajlarda hafif önden kayma (understeer).
export function physicsPreset(name) {
  if (name === 'easy') {
    return {
      mass: 798, power: 420, cda: 1.6, cla: 5.5, mu: 2.2, weightFront: 0.46, aeroFront: 0.46, cgHeight: 0.22,
      loadSens: 0.04, minRadius: 6, steerSpeed: 6, rollRes: 0.015, scrub: 0.25, carRadius: 1.0,
    };
  }
  return {
    mass: 798,        // kg (araç + pilot, yakıt hariç)
    power: 750,       // kW toplam (≈ 630 kW V6 turbo + 120 kW ERS)
    cda: 1.45,        // m² sürükleme katsayısı × ön alan
    cla: 4.4,         // m² yere basma katsayısı × alan
    mu: 1.72,         // lastik sürtünme katsayısı (ideal sıcaklıkta, yeni lastik)
    weightFront: 0.45, // statik ağırlığın ön aksa düşen payı
    aeroFront: 0.42,  // yere basmanın ön aksa düşen payı (aero dengesi)
    cgHeight: 0.28,   // m, ağırlık merkezi yüksekliği (yük transferi)
    loadSens: 0.08,   // lastik yük hassasiyeti (yük arttıkça μ düşer)
    minRadius: 7,     // m, tam direksiyonda en küçük dönüş yarıçapı
    steerSpeed: 4,    // direksiyonun saniyedeki en büyük değişimi (tam kilit = 1)
    rollRes: 0.012,   // yuvarlanma direnci
    scrub: 0.25,      // kayarken lastik sürtünmesinden hız kaybı
    carRadius: 1.0,   // m, duvar çarpışma yarıçapı
  };
}

// Lastik hamurları: tutuş çarpanı, ideal sıcaklık (°C), aşınma hızı çarpanı
export const COMPOUNDS = {
  soft: { label: 'Yumuşak (C5)', short: 'S', color: '#ef4444', mu: 1.025, topt: 95, wear: 1.7 },
  medium: { label: 'Orta (C3)', short: 'M', color: '#facc15', mu: 1.0, topt: 102, wear: 1.0 },
  hard: { label: 'Sert (C1)', short: 'H', color: '#e5e7eb', mu: 0.975, topt: 110, wear: 0.6 },
};
export const COMPOUND_IDS = ['soft', 'medium', 'hard'];

// Araç sistemleri ve strateji (lastik, yakıt, ERS, DRS, pit)
export function defaultCar() {
  return {
    compound: 'medium',
    tyreTemp: true,      // lastik sıcaklığı tutuşu etkilesin
    startTemp: 90,       // °C (ısıtıcı battaniyeden çıkış)
    trackTemp: 35,       // °C pist sıcaklığı
    wear: true,          // lastik aşınması
    wearMul: 1,          // aşınma hızlandırıcı (deney için; 1 = gerçekçi)
    fuel: 'auto',        // 'auto' = tur sayısına yetecek kadar, yoksa kg
    fuelPerKm: 0.33,     // kg/km tüketim tahmini (otomatik yakıt için)
    ers: true,           // MGU-K: 120 kW, 4 MJ batarya, turda en çok 4 MJ kullanım / 2 MJ frenden şarj
    drs: 'zones',        // 'off' | 'zones' (bölgede serbest, sıralama gibi) | 'race' (öndeki araca < 1 sn)
    pitLap: 0,           // 0 = pit yok; n = n. turun sonunda pite gir
    pitCompound: 'hard',
    pitLossSec: 21,      // pit şeridi + lastik değişimi kaybı
  };
}

// ERS sabitleri (2014-2025 kuralları)
export const ERS = { kKW: 120, storeJ: 4e6, deployLapJ: 4e6, harvestLapJ: 2e6, hKW: 40 };
// DRS etkisi
export const DRS = { cda: 0.85, cla: 0.9 };
export const FUEL_FLOW_KGS = 100 / 3600; // en çok 100 kg/saat

// Tur süresi biçimi: 59.12 sn veya 1:36.169
export function fmtLap(sec) {
  if (sec == null || !isFinite(sec)) return '–';
  if (sec < 60) return sec.toFixed(2) + ' sn';
  const m = Math.floor(sec / 60);
  const r = sec - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(3)}`;
}

// Pist uzunluğuna göre makul süre limiti (≈ 72 km/s ortalama)
export function autoTimeLimit(track) {
  return Math.max(30, Math.min(400, Math.round(track.lengthMeters / 20 / 5) * 5));
}

// Eski kayıtlarda olmayan fizik alanlarını tamamla
export function completePhysics(P) {
  const base = physicsPreset('f1');
  for (const k of Object.keys(base)) if (P[k] == null) P[k] = base[k];
  return P;
}

export function physicsSummary(P) {
  const k = (0.5 * AIR_DENSITY) / P.mass;
  // son hız: güç = sürükleme gücü + yuvarlanma
  let v = 30;
  for (let i = 0; i < 60; i++) {
    const f = (P.power * 1000) / (P.mass * v) - k * P.cda * v * v - P.rollRes * GRAVITY;
    v += f * 0.5;
  }
  const v83 = 83.3;
  const grip = (vv) => P.mu * (GRAVITY + k * P.cla * vv * vv);
  return {
    vmaxKmh: v * 3.6,
    brake300: (grip(v83) + k * P.cda * v83 * v83) / GRAVITY,
    latFast: grip(v83) / GRAVITY,
    latSlow: grip(22) / GRAVITY,
    accel0: Math.min((1 - (P.weightFront ?? 0.45)) * 1.15 * grip(0), (P.power * 1000) / (P.mass * 15)) / GRAVITY,
  };
}

// Sensör ışınlarının açıları (derece, aracın burnuna göre)
export const RAY_ANGLES_DEG = [-90, -60, -35, -15, 0, 15, 35, 60, 90];

// İleri bakış mesafeleri (m): pistin bu kadar ilerisindeki yönün araca göre açısı (viraj/fren noktası sezgisi)
export const LOOKAHEAD_M = [35, 90, 170, 280];

// Gözlem vektörü düzeni
const NR = RAY_ANGLES_DEG.length;
export const OBS = {
  rays: 0,
  speed: NR,
  heading: NR + 1,
  look: NR + 2,
  lateral: NR + 2 + LOOKAHEAD_M.length, // pist ortasına göre yanal konum (−1 sol kenar, +1 sağ kenar)
  cornerDist: NR + 3 + LOOKAHEAD_M.length, // sonraki viraj tepe noktasına uzaklık (0-1, 400 m)
  cornerSharp: NR + 4 + LOOKAHEAD_M.length, // sonraki virajın keskinliği (işaretli, 30 m yarıçap = 1)
  grade: NR + 5 + LOOKAHEAD_M.length, // yokuş/iniş
  beta: NR + 6 + LOOKAHEAD_M.length, // kayma açısı (arka kayması)
  grip: NR + 7 + LOOKAHEAD_M.length, // lastik tutuş durumu (sıcaklık + aşınma)
  drs: NR + 8 + LOOKAHEAD_M.length,
  ers: NR + 9 + LOOKAHEAD_M.length,
  gap: NR + 10 + LOOKAHEAD_M.length, // yarış: öndeki araca mesafe (1 = yok)
  gapLat: NR + 11 + LOOKAHEAD_M.length, // yarış: öndeki aracın yanal farkı
};
export const OBS_SIZE = NR + 12 + LOOKAHEAD_M.length; // 25
export const OBS_SIZE_V1 = NR + 2 + LOOKAHEAD_M.length; // 15 (eski beyinler)
export const INPUT_LABELS = [
  'Işın −90°', 'Işın −60°', 'Işın −35°', 'Işın −15°', 'Işın 0°', 'Işın +15°', 'Işın +35°', 'Işın +60°', 'Işın +90°',
  'Hız', 'Yön hatası', 'Viraj 35 m', 'Viraj 90 m', 'Viraj 170 m', 'Viraj 280 m',
  'Yanal konum', 'Viraja uzaklık', 'Viraj keskinliği', 'Eğim', 'Kayma açısı', 'Lastik tutuşu', 'DRS', 'ERS şarj',
  'Öndeki araç', 'Öndeki yanal',
];

// PPO için ayrık aksiyon tablosu: [direksiyon, gaz]
export const DISCRETE_ACTIONS = [
  [-1, 1], [0, 1], [1, 1],     // gaz + sol / düz / sağ
  [-1, 0], [0, 0], [1, 0],     // boşta
  [-1, -1], [0, -1], [1, -1],  // fren
];

export function defaultConfig() {
  return {
    physics: physicsPreset('f1'),
    car: defaultCar(),
    sensors: {
      maxRay: 200,        // m
    },
    rules: {
      laps: 1,
      timeLimitSec: 60,   // pist seçilince uzunluğa göre otomatik ayarlanır (tur başına)
      stallSec: 2.5,      // bu süre ilerleme olmazsa elenir
      maxCrashes: 1,      // 1 = ilk çarpmada elenir; >1 = sekip devam eder
      backLimit: 40,      // geri geri gitme toleransı (m)
      startJitter: 0,     // başlangıçta konum/yön rastgeleliği (0-1)
      spawn: 'start',     // 'start' | 'mixed' | 'random' (pistin rastgele noktasından uçan başlangıç)
      mode: 'solo',       // 'solo' | 'race' (aynı serideki araçlar birbirine çarpabilir, sollama ödülü)
      heatSize: 6,        // yarış modunda bir serideki araç sayısı
    },
    reward: {
      progress: 1000,     // tam tur boyunca toplanan ilerleme ödülü
      crash: 60,          // çarpma cezası
      timePenalty: 0.05,  // her adımda küçük ceza (hızlı olmaya iter)
      finish: 500,        // bitirme ödülü
      speedBonus: 20,     // süre limitinden kazanılan her saniye için bonus
      stall: 80,          // takılma/geri gitme cezası (çarpmadan büyük olmalı: hareketsiz kalmak "güvenli" olmasın)
      overtake: 25,       // yarış: geçilen her araç için ödül (geçilince aynı miktar ceza)
      contact: 40,        // yarış: araçlar arası temas cezası (arkadan vuran tam, önde olan yarım)
      position: 150,      // yarış: bitiriş sırası bonusu (1. tam, sonuncu 0)
    },
    ga: {
      hidden: [16, 12],
      eliteFrac: 0.05,
      selectFrac: 0.25,
      mutRate: 0.1,
      mutStd: 0.12,
      crossover: 0.6,
      adaptive: true,
    },
    es: {
      hidden: [16, 12],
      sigma: 0.1,
      lr: 0.03,
      wd: 0.005,
    },
    ppo: {
      hidden: [32, 32],
      rollout: 32,
      gamma: 0.99,
      lambda: 0.95,
      lr: 0.0003,
      clip: 0.2,
      epochs: 3,
      minibatch: 512,
      maxBatch: 2048,
      entropy: 0.004,
      vcoef: 0.5,
      rewardScale: 0.01,
      rewardClip: 3,      // ölçeklenmiş adım ödülü kırpma sınırı (0 = kapalı)
      maxGradNorm: 0.5,
    },
  };
}

// Eski bir yapılandırmayı (kayıt/beyin) güncel alanlarla tamamlar
export function completeConfig(cfg) {
  const d = defaultConfig();
  for (const sec of ['physics', 'car', 'sensors', 'rules', 'reward']) {
    cfg[sec] = { ...d[sec], ...(cfg[sec] || {}) };
  }
  return cfg;
}
