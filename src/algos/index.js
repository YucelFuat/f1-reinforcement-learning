// Algoritma kaydı. Yeni bir algoritma eklemek için buraya bir giriş eklemek yeterlidir:
//   label       : arayüzde görünen ad
//   kind        : 'population' (nesil sonunda endGeneration(fitness)) | 'continuous' (her adım record(sim), arka planda güncelleme)
//   create      : (N, cfgAll, rng, opts) => algoritma nesnesi
//   defaults    : cfg[ad] yoksa kullanılacak varsayılan ayarlar
//   ui          : ayar kaydırıcıları [{ key, label, min, max, step, restart?, help? }]  (key: cfg[ad][key])
//   minN        : en az araç sayısı
//   description : ayar panelinde gösterilen kısa açıklama
// Tüm algoritmalar ayrıca getState() / setState(state) sağlar (eğitimi kaldığı yerden sürdürmek için).
import { GeneticAlgorithm } from './ga.js';
import { EvolutionStrategy } from './es.js';
import { PPOAgent } from './ppo.js';
import { PPOContAgent, PPOC_DEFAULTS } from './ppo-cont.js';
import { SepCMAES, CMAES_DEFAULTS } from './cmaes.js';
import { SACAgent, SAC_DEFAULTS } from './sac.js';

export const ALGOS = {
  ga: {
    label: 'Genetik Algoritma (Neuroevolution)',
    kind: 'population',
    minN: 2,
    create: (N, cfg, rng) => new GeneticAlgorithm(N, cfg, rng),
  },
  es: {
    label: 'Evolution Strategies (OpenAI-ES)',
    kind: 'population',
    minN: 3,
    create: (N, cfg, rng) => new EvolutionStrategy(N, cfg, rng),
  },
  cmaes: {
    label: 'CMA-ES (ayrık köşegen, sep-CMA)',
    kind: 'population',
    minN: 4,
    defaults: CMAES_DEFAULTS,
    create: (N, cfg, rng) => new SepCMAES(N, cfg, rng),
    ui: [
      { key: 'sigma0', label: 'Başlangıç adım boyu (σ₀)', min: 0.02, max: 1, step: 0.01, restart: true, help: 'Aramanın ilk genişliği. Sonra evrim yolu ile kendiliğinden ayarlanır.' },
      { key: 'muFrac', label: 'Seçilen oran (μ/λ)', min: 0.1, max: 0.5, step: 0.05, help: 'Ortalamayı güncelleyen en iyi araçların oranı (ağırlıklı).' },
      { key: 'sigmaMin', label: 'En küçük σ', min: 0.0001, max: 0.05, step: 0.0001, help: 'Adım boyu bunun altına inmez (aramanın tamamen durmasını önler).' },
    ],
    description:
      'Kovaryans Matris Uyarlamalı Evrim Stratejisi (köşegen sürüm). Tek bir ortalama ağ etrafında σ·√C ölçekli Gauss ' +
      'gürültüsüyle araçlar üretir; en iyilerin ağırlıklı ortalamasına ilerler. Adım boyu (σ) ve her ağırlığın kendi ' +
      'arama genişliği (C) otomatik ayarlanır. 0 numaralı araç gürültüsüz ortalamayı sürer.',
  },
  ppo: {
    label: 'PPO – Actor-Critic, ayrık (adım bazlı ödül)',
    kind: 'continuous',
    minN: 1,
    create: (N, cfg, rng, opts) => new PPOAgent(N, cfg, rng, opts),
  },
  ppoc: {
    label: 'PPO – sürekli aksiyon (Gauss)',
    kind: 'continuous',
    minN: 4,
    defaults: PPOC_DEFAULTS,
    create: (N, cfg, rng, opts) => new PPOContAgent(N, cfg, rng, opts),
    ui: [
      { key: 'lr', label: 'Öğrenme hızı', min: 0.00005, max: 0.003, step: 0.00005 },
      { key: 'actionRepeat', label: 'Aksiyon tekrarı (adım)', min: 1, max: 8, step: 1, help: 'Politika her K simülasyon adımında bir karar verir (60 Hz / K). Daha uzun ufuk, daha hızlı öğrenme.' },
      { key: 'rollout', label: 'Rollout uzunluğu (karar)', min: 8, max: 128, step: 8, restart: true },
      { key: 'epochs', label: 'Epoch', min: 1, max: 10, step: 1 },
      { key: 'clip', label: 'PPO kırpma (ε)', min: 0.05, max: 0.4, step: 0.01 },
      { key: 'gamma', label: 'İndirim (γ, karar başına)', min: 0.9, max: 0.999, step: 0.001 },
      { key: 'lambda', label: 'GAE (λ)', min: 0.8, max: 1, step: 0.01 },
      { key: 'entropy', label: 'Entropi katsayısı (keşif)', min: 0, max: 0.02, step: 0.0005 },
      { key: 'targetKL', label: 'Hedef KL (erken durma, 0 = kapalı)', min: 0, max: 0.1, step: 0.005 },
      { key: 'maxBatch', label: 'Güncelleme başına örnek', min: 1024, max: 16384, step: 1024 },
      { key: 'initLogStd', label: 'Başlangıç log σ', min: -2, max: 0.5, step: 0.1, restart: true, help: 'Başlangıçtaki keşif gürültüsü (etkin aksiyon biriminde σ = e^x).' },
      { key: 'obsNorm', label: 'Gözlem normalizasyonu (0/1)', min: 0, max: 1, step: 1, restart: true },
      { key: 'rewardNorm', label: 'Ödül normalizasyonu (0/1)', min: 0, max: 1, step: 1 },
    ],
    description:
      'Gauss politikalı PPO: ağ direksiyon ve gaz/fren için ortalama (μ) üretir, öğrenilen σ kadar gürültüyle keşfeder. ' +
      'Ayrık PPO\'dan farkı: aksiyonlar kademesiz, karar sıklığı ayarlanabilir (aksiyon tekrarı) ve gözlem/ödül normalize edilir. ' +
      'Tekrar ve dışa aktarmada gürültüsüz ortalama aksiyon kullanılır.',
  },
  sac: {
    label: 'SAC – Soft Actor-Critic',
    kind: 'continuous',
    minN: 4,
    defaults: SAC_DEFAULTS,
    create: (N, cfg, rng, opts) => new SACAgent(N, cfg, rng, opts),
    ui: [
      { key: 'lr', label: 'Öğrenme hızı', min: 0.00005, max: 0.003, step: 0.00005 },
      { key: 'batch', label: 'Mini-batch boyu', min: 32, max: 512, step: 32, help: 'Küçük batch + çok adım, aynı hesapla daha hızlı öğrenir (varsayılan 128 × 64 adım).' },
      { key: 'gradSteps', label: 'Tur başına gradyan adımı', min: 1, max: 256, step: 1, help: 'Her turda (aşağıdaki adım sayısı kadar simülasyon) yapılan öğrenme adımı. Artırmak veriyi daha çok kullanır ama yavaşlatır.' },
      { key: 'updateEvery', label: 'Tur uzunluğu (sim. adımı)', min: 4, max: 256, step: 4 },
      { key: 'actionRepeat', label: 'Aksiyon tekrarı (adım)', min: 1, max: 8, step: 1, help: 'Politika her K simülasyon adımında bir karar verir (60 Hz / K).' },
      { key: 'gamma', label: 'İndirim (γ, karar başına)', min: 0.9, max: 0.999, step: 0.001 },
      { key: 'nStep', label: 'n-adımlı getiri (n)', min: 1, max: 10, step: 1, help: 'Ödül n karar boyunca toplanıp sonra Q ile önyüklenir: kredi daha hızlı geriye yayılır (1 = klasik SAC).' },
      { key: 'tau', label: 'Hedef ağ izleme hızı (τ)', min: 0.001, max: 0.05, step: 0.001 },
      { key: 'targetEntropy', label: 'Hedef entropi', min: -6, max: 1, step: 0.1, help: 'α bunu tutturacak şekilde otomatik ayarlanır (varsayılan −2 = −aksiyon sayısı).' },
      { key: 'rewardScale', label: 'Ödül ölçeği', min: 0.01, max: 1, step: 0.01, help: 'Ödüller bu katsayıyla çarpılıp öğreniciye verilir (entropi ile ödül arasındaki denge).' },
      { key: 'warmup', label: 'Isınma (geçiş)', min: 1000, max: 100000, step: 1000, help: 'Bellekte bu kadar geçiş birikmeden öğrenme başlamaz.' },
      { key: 'bufferSize', label: 'Bellek boyu (geçiş)', min: 20000, max: 1000000, step: 10000, restart: true },
      { key: 'alpha0', label: 'Başlangıç α', min: 0.001, max: 1, step: 0.001, restart: true },
      { key: 'obsNorm', label: 'Gözlem normalizasyonu (0/1)', min: 0, max: 1, step: 1, restart: true },
    ],
    description:
      'Politika dışı (off-policy) actor-critic: tüm araçların deneyimi büyük bir tekrar belleğinde toplanır, iki Q ağı ' +
      've hedef kopyaları ile değer öğrenilir; aktör en yüksek Q + entropiyi hedefler. Keşif miktarı (α) otomatik ' +
      'ayarlanır. Öğrenme ayrı bir çekirdekte çalışır; çok araçla veri bol olduğundan güncelleme oranı sabittir. ' +
      'Tekrarda gürültüsüz ortalama aksiyon kullanılır.',
  },
};

export function algoLabel(name) {
  return ALGOS[name]?.label || name;
}
