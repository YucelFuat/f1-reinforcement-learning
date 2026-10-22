// Son işleme (post-processing) zinciri — tekrar sahnesi için.
//   'high'  : sahne → hız bulanıklığı (derinliğe duyarlı) → GTAO (ortam perdelemesi, logaritmik derinliğe uyarlanmış)
//             → bloom → OutputPass → SMAA. Bulanıklık sahne derinliğini okuduğu için sahneden hemen sonra gelir.
//   'medium': sahne → bloom (yarım çözünürlük) → OutputPass → FXAA
//   'off'   : doğrudan renderer.render (son işleme yok)
// Not: Bir render hedefine çizerken three.js ton eşlemeyi (ACES) ve sRGB dönüşümünü UYGULAMAZ; bunları zincirin sonundaki
// OutputPass bir kez yapar → parlaklık, son işlemesiz çizimle aynı kalır. Kendi ton eşleme/renk dönüşümü olmayan
// "ham" ShaderMaterial'lar (ör. gökyüzü kubbesi) ekrana ham değer yazar; zincir açıkken bunların çıktısı ters ACES+sRGB
// ile ön-düzeltilir, böylece OutputPass sonrası piksel değeri birebir aynı olur.

import * as THREE from '../vendor/three.module.min.js';
import { EffectComposer } from '../vendor/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/addons/postprocessing/RenderPass.js';
import { ShaderPass } from '../vendor/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from '../vendor/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/addons/postprocessing/OutputPass.js';
import { SMAAPass } from '../vendor/addons/postprocessing/SMAAPass.js';
import { GTAOPass } from '../vendor/addons/postprocessing/GTAOPass.js';
import { FXAAShader } from '../vendor/addons/shaders/FXAAShader.js';

// ---------- ayarlar ----------
const BLOOM = {
  high: { strength: 0.22, radius: 0.45, threshold: 2.2, scale: 1 },
  medium: { strength: 0.2, radius: 0.4, threshold: 2.2, scale: 0.5 },
};
const AO = { radius: 1.1, thickness: 0.7, distanceExponent: 1.5, distanceFallOff: 1, scale: 1.1, samples: 12, maxDist: 260, resScale: 0.5, intensity: 0.8 };
const BLUR = { maxStrength: 0.03, start: 0.3, samples: 8, nearCut: 4.5 }; // nearCut: bu mesafeden yakın (araç gövdesi) bulanıklaşmaz

// ---------- logaritmik derinlik tamponuna uyarlanmış GTAO ----------
// GTAOPass/PoissonDenoise derinliği perspektif (doğrusal olmayan z) varsayar; logarithmicDepthBuffer açıkken derinlik
// dokusunda log2(1 + w) / log2(far + 1) bulunur. getViewPosition() bu formüle göre yeniden yazılır.
const LOG_VIEWPOS = /* glsl */ `
uniform float pfxLogFar;   // log2(far + 1)
uniform float pfxMaxDepth; // bu derinlikten uzak pikseller atlanır (AO = 1)
vec3 getViewPosition(const in vec2 screenPosition, const in float depth) {
  float w = exp2(depth * pfxLogFar) - 1.0;                       // kameraya uzaklık (-viewZ)
  vec4 p = cameraProjectionMatrixInverse * vec4(screenPosition * 2.0 - 1.0, 0.0, 1.0);
  p.xyz /= p.w;                                                   // aynı ışın üzerindeki bir nokta
  return p.xyz * (w / -p.z);
}`;
const VIEWPOS_RE = /vec3 getViewPosition\(const in vec2 screenPosition, const in float depth\) \{[\s\S]*?return viewSpacePosition\.xyz \/ viewSpacePosition\.w;\s*\}/;

class LogDepthGTAOPass extends GTAOPass {
  constructor(scene, camera, w, h, resScale, logDepth = true) {
    super(scene, camera, w, h, { depthTexture: new THREE.DepthTexture(1, 1) });
    this.resScale = resScale;
    this.logU = { value: Math.log2(camera.far + 1) };
    this.maxU = { value: 1 };
    this.logDepth = logDepth;
    if (!logDepth) return; // normal derinlik tamponu: üç.js'in özgün gölgelendiricisi doğru çalışır
    for (const m of [this.gtaoMaterial, this.pdMaterial]) {
      if (!VIEWPOS_RE.test(m.fragmentShader)) throw new Error('GTAO gölgelendiricisi beklenen biçimde değil');
      m.fragmentShader = m.fragmentShader.replace(VIEWPOS_RE, LOG_VIEWPOS);
      m.uniforms.pfxLogFar = this.logU;
      m.uniforms.pfxMaxDepth = this.maxU;
      m.needsUpdate = true;
    }
    // uzak pikselleri hiç hesaplama (beyaz = perdeleme yok olarak temizlenir)
    this.gtaoMaterial.fragmentShader = this.gtaoMaterial.fragmentShader.replace('if (depth >= 1.0) {', 'if (depth >= pfxMaxDepth) {');
    this.pdMaterial.fragmentShader = this.pdMaterial.fragmentShader.replace('if (depth == 1. ||', 'if (depth >= pfxMaxDepth ||');
  }
  // r160: dışarıdan derinlik verilince normalRenderTarget oluşturulmuyor ama setSize/dispose ona erişiyor → yer tutucu
  setGBuffer(depthTexture, normalTexture) {
    if (depthTexture !== undefined && !this.normalRenderTarget) {
      this.normalRenderTarget = { depthTexture, texture: null, setSize() {}, dispose() {} };
    }
    super.setGBuffer(depthTexture, normalTexture);
  }
  setSize(w, h) {
    super.setSize(Math.max(1, Math.round(w * this.resScale)), Math.max(1, Math.round(h * this.resScale)));
  }
  render(renderer, writeBuffer, readBuffer, dt, mask) {
    // sahne derinliği: SceneRenderPass'in o karede çizdiği hedefin derinlik dokusu (tampon takası her karede değişebilir)
    const dtx = this.depthSource?.depthTexture || readBuffer.depthTexture;
    this.gtaoMaterial.uniforms.tDepth.value = dtx;
    this.pdMaterial.uniforms.tDepth.value = dtx;
    this.logU.value = Math.log2(this.camera.far + 1);
    this.maxU.value = Math.log2(AO.maxDist + 1) / this.logU.value;
    super.render(renderer, writeBuffer, readBuffer, dt, mask);
  }
}

// sahneyi çizen geçiş: o karede kullandığı derinlik dokusunu sonraki geçişler için saklar
class SceneRenderPass extends RenderPass {
  render(renderer, writeBuffer, readBuffer, dt, mask) {
    super.render(renderer, writeBuffer, readBuffer, dt, mask);
    this.depthTexture = readBuffer.depthTexture;
  }
}

// ---------- hız bulanıklığı: ekran merkezinden ışınsal (zoom) bulanıklık ----------
// Derinlik dokusu varsa yakın pikseller (kokpit kamerasında aracın kendisi) bulanıklaşmaz ve örneklere karışmaz.
const RadialBlurShader = {
  name: 'RadialBlurShader',
  defines: { SAMPLES: BLUR.samples, USE_DEPTH: 0, LOG_DEPTH: 1 },
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    strength: { value: 0 },
    center: { value: new THREE.Vector2(0.5, 0.52) },
    aspect: { value: 1 },
    start: { value: BLUR.start },
    nearCut: { value: BLUR.nearCut },
    logFar: { value: 13 },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 1000 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    #include <packing>
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform float strength;
    uniform vec2 center;
    uniform float aspect;
    uniform float start;
    uniform float nearCut;
    uniform float logFar;
    uniform float cameraNear;
    uniform float cameraFar;
    varying vec2 vUv;
    float farW(vec2 uv) {          // 1: uzak (bulanıklaşabilir), 0: yakın (araç)
    #if USE_DEPTH == 1
      float z = texture2D(tDepth, uv).x;
      #if LOG_DEPTH == 1
        float dist = exp2(z * logFar) - 1.0;
      #else
        float dist = -perspectiveDepthToViewZ(z, cameraNear, cameraFar);
      #endif
      return smoothstep(nearCut, nearCut * 1.8, dist);
    #else
      return 1.0;
    #endif
    }
    void main() {
      vec4 c0 = texture2D(tDiffuse, vUv);
      vec2 d = vUv - center;
      float r = length(d * vec2(aspect, 1.0));
      float m = smoothstep(start, start + 0.45, r) * farW(vUv); // merkez net kalır, kenarlara doğru artar
      if (m < 0.002) { gl_FragColor = c0; return; }
      vec2 stepv = d * (strength * m / float(SAMPLES));
      float jit = fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453); // bantlaşmayı kırar
      vec4 acc = c0;
      float wsum = 1.0;
      for (int i = 1; i < SAMPLES; i++) {
        vec2 uv = vUv - stepv * (float(i) + jit);
        float w = farW(uv);
        acc += texture2D(tDiffuse, uv) * w;
        wsum += w;
      }
      gl_FragColor = acc / wsum;
    }`,
};
class DepthBlurPass extends ShaderPass {
  render(renderer, writeBuffer, readBuffer, dt, mask) {
    const dtx = this.depthSource?.depthTexture || null;
    this.uniforms.tDepth.value = dtx;
    const want = dtx ? 1 : 0;
    if (this.material.defines.USE_DEPTH !== want) {
      this.material.defines.USE_DEPTH = want;
      this.material.needsUpdate = true;
    }
    this.uniforms.logFar.value = Math.log2(this.camera.far + 1);
    this.uniforms.cameraNear.value = this.camera.near;
    this.uniforms.cameraFar.value = this.camera.far;
    super.render(renderer, writeBuffer, readBuffer, dt, mask);
  }
}

// ---------- "ham" shader malzemeleri için ters ton eşleme (ACES Filmic + sRGB) ----------
// three r160 ACESFilmicToneMapping ile birebir aynı sabitler; tersleri JS'te hesaplanır.
function mat3Glsl(cols) {
  // cols: GLSL mat3 sütunları → JS Matrix3 (satır öncelikli set)
  const m = new THREE.Matrix3().set(cols[0][0], cols[1][0], cols[2][0], cols[0][1], cols[1][1], cols[2][1], cols[0][2], cols[1][2], cols[2][2]);
  return m;
}
function glslMat3(m) {
  const e = m.elements; // sütun öncelikli
  const f = (v) => v.toFixed(7);
  return `mat3(${f(e[0])}, ${f(e[1])}, ${f(e[2])}, ${f(e[3])}, ${f(e[4])}, ${f(e[5])}, ${f(e[6])}, ${f(e[7])}, ${f(e[8])})`;
}
const ACES_IN = mat3Glsl([[0.59719, 0.076, 0.0284], [0.35458, 0.90834, 0.13383], [0.04823, 0.01566, 0.83777]]);
const ACES_OUT = mat3Glsl([[1.60475, -0.10208, -0.00327], [-0.53108, 1.10813, -0.07276], [-0.07367, -0.00605, 1.07602]]);
const INV_GLSL = /* glsl */ `
uniform float pfxExposure;
vec3 pfxInvOutput(vec3 raw) {
  vec3 t = clamp(raw, 0.0, 0.995);                                     // ekrana yazılacak değer (ham çizimde kırpılır)
  vec3 L = mix(t / 12.92, pow((t + 0.055) / 1.055, vec3(2.4)), step(0.04045, t)); // sRGB → doğrusal
  vec3 u = clamp(${glslMat3(ACES_OUT.clone().invert())} * L, 0.0, 1.0);
  // RRTAndODTFit(v) = u  →  (0.983729u - 1)v² + (0.432951u - 0.0245786)v + (0.238081u + 0.000090537) = 0
  vec3 A = 0.983729 * u - 1.0;
  vec3 B = 0.4329510 * u - 0.0245786;
  vec3 C = 0.238081 * u + 0.000090537;
  vec3 v = (-B - sqrt(max(B * B - 4.0 * A * C, 0.0))) / (2.0 * A);
  return max(${glslMat3(ACES_IN.clone().invert())} * v, 0.0) * (0.6 / pfxExposure);
}
`;
const MAIN_RE = /void\s+main\s*\(\s*(void)?\s*\)/;

function isRawShader(m) {
  if (!m || !m.isShaderMaterial || m.isRawShaderMaterial || m.userData.pfxNoFix) return false;
  if (m.userData.pfxOrig !== undefined) return true;
  const fs = m.fragmentShader || '';
  return MAIN_RE.test(fs) && !/tonemapping_fragment|colorspace_fragment|encodings_fragment|linearToOutputTexel/.test(fs);
}

// ---------- ana fabrika ----------
export function createPostFX(renderer, scene, camera, { quality = 'high', aoLogPatch = true } = {}) {
  let q = 'off';
  let composer = null;
  let P = {}; // etkin geçişler
  const sizeV = new THREE.Vector2();
  let lastW = 0, lastH = 0;
  const exposureU = { value: renderer.toneMappingExposure };
  const patched = new Set();
  let frame = 0;
  const logDepth = !!renderer.capabilities.logarithmicDepthBuffer;

  // --- ham malzemeleri yamala / geri al ---
  function patchRaw(on) {
    if (!on) {
      for (const m of patched) {
        m.fragmentShader = m.userData.pfxOrig;
        delete m.userData.pfxOrig;
        delete m.uniforms.pfxExposure;
        m.needsUpdate = true;
      }
      patched.clear();
      return;
    }
    if (renderer.toneMapping !== THREE.ACESFilmicToneMapping && renderer.toneMapping !== THREE.NoToneMapping) return; // yalnız ACES/yok desteklenir
    scene.traverse((o) => {
      const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of ms) {
        if (patched.has(m) || !isRawShader(m)) continue;
        m.userData.pfxOrig = m.fragmentShader;
        const aces = renderer.toneMapping === THREE.ACESFilmicToneMapping;
        m.fragmentShader =
          INV_GLSL +
          m.fragmentShader.replace(MAIN_RE, 'void pfxRawMain()') +
          (aces
            ? '\nvoid main() { pfxRawMain(); gl_FragColor.rgb = pfxInvOutput(gl_FragColor.rgb); }\n'
            : '\nvoid main() { pfxRawMain(); vec3 t = clamp(gl_FragColor.rgb, 0.0, 1.0); gl_FragColor.rgb = mix(t / 12.92, pow((t + 0.055) / 1.055, vec3(2.4)), step(0.04045, t)); }\n');
        m.uniforms.pfxExposure = exposureU;
        m.needsUpdate = true;
        patched.add(m);
      }
    });
  }

  function disposeComposer() {
    if (!composer) return;
    for (const p of composer.passes) p.dispose?.();
    composer.renderTarget1.dispose();
    composer.renderTarget2.dispose();
    composer.dispose?.();
    composer = null;
    P = {};
  }

  function build(qual) {
    disposeComposer();
    renderer.getSize(sizeV);
    const pr = renderer.getPixelRatio();
    const W = Math.max(1, Math.floor(sizeV.x * pr)), H = Math.max(1, Math.floor(sizeV.y * pr));
    const wantAO = qual === 'high' && renderer.capabilities.isWebGL2;
    const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType });
    if (wantAO) {
      rt.depthTexture = new THREE.DepthTexture(W, H);
      rt.depthTexture.type = THREE.UnsignedIntType;
    }
    composer = new EffectComposer(renderer, rt);
    if (wantAO) {
      // clone() derinlik dokusunu aynı Source ile kopyalar → three iki hedefe AYNI GL dokusunu bağlar ve
      // bir hedefe yazarken diğerinin derinliğini okumak geri besleme döngüsü olur. İkinci hedefe ayrı doku ver.
      composer.renderTarget2.depthTexture = new THREE.DepthTexture(W, H);
      composer.renderTarget2.depthTexture.type = THREE.UnsignedIntType;
    }
    composer.setPixelRatio(pr);
    composer.setSize(sizeV.x, sizeV.y);
    P.render = new SceneRenderPass(scene, camera);
    composer.addPass(P.render);
    // hız bulanıklığı sahnenin hemen ardından: derinliği okuyabilmesi için (aksi hâlde aynı hedefe yazıp okuma döngüsü oluşur)
    if (qual === 'high') {
      P.blur = new DepthBlurPass(RadialBlurShader);
      P.blur.camera = camera;
      P.blur.depthSource = wantAO ? P.render : null;
      P.blur.material.defines.LOG_DEPTH = logDepth ? 1 : 0;
      P.blur.enabled = false;
      composer.addPass(P.blur);
    }
    if (wantAO) {
      try {
        P.ao = new LogDepthGTAOPass(scene, camera, W, H, AO.resScale, logDepth && aoLogPatch);
        P.ao.updateGtaoMaterial(AO);
        P.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 8 });
        P.ao.blendIntensity = AO.intensity;
        P.ao.depthSource = P.render;
        composer.addPass(P.ao);
      } catch (e) {
        console.warn('AO devre dışı:', e);
        P.ao = null;
      }
    }
    const B = BLOOM[qual];
    P.bloom = new UnrealBloomPass(new THREE.Vector2(W, H), B.strength, B.radius, B.threshold);
    if (B.scale !== 1) {
      const orig = P.bloom.setSize.bind(P.bloom);
      P.bloom.setSize = (w, h) => orig(Math.max(2, Math.round(w * B.scale)), Math.max(2, Math.round(h * B.scale)));
      P.bloom.setSize(W, H);
    }
    composer.addPass(P.bloom);
    P.output = new OutputPass();
    composer.addPass(P.output);
    if (qual === 'high') {
      P.aa = new SMAAPass(W, H);
    } else {
      P.aa = new ShaderPass(FXAAShader);
    }
    composer.addPass(P.aa);
    lastW = 0;
    resizeIfNeeded();
  }

  function resizeIfNeeded() {
    if (!composer) return;
    renderer.getSize(sizeV);
    const pr = renderer.getPixelRatio();
    const W = Math.max(1, Math.floor(sizeV.x * pr)), H = Math.max(1, Math.floor(sizeV.y * pr));
    if (W === lastW && H === lastH) return;
    lastW = W;
    lastH = H;
    composer.setPixelRatio(pr);
    composer.setSize(sizeV.x, sizeV.y);
    if (P.aa && P.aa.material?.uniforms?.resolution) P.aa.material.uniforms.resolution.value.set(1 / W, 1 / H);
    if (P.blur) P.blur.uniforms.aspect.value = W / H;
  }

  const api = {
    get quality() {
      return q;
    },
    get passes() {
      return P;
    },
    // dt: saniye, speedN: hız / 95 m/s (0 → bulanıklık yok; helikopter gibi uzak kameralarda 0 verin)
    render(dt = 0, speedN = 0) {
      exposureU.value = renderer.toneMappingExposure;
      if (q === 'off' || !composer) {
        renderer.render(scene, camera);
        return;
      }
      if (frame++ % 120 === 0) patchRaw(true); // sonradan eklenen ham malzemeleri de yakala
      resizeIfNeeded();
      if (P.blur) {
        const s = Math.max(0, Math.min(1.2, speedN) - 0.25) / 0.85;
        const k = BLUR.maxStrength * s * s;
        P.blur.enabled = k > 0.002;
        P.blur.uniforms.strength.value = k;
      }
      composer.render(dt);
    },
    setSize() {
      lastW = 0;
      resizeIfNeeded();
    },
    setQuality(qual) {
      qual = qual === 'high' || qual === 'medium' ? qual : 'off';
      if (qual === q) return;
      q = qual;
      if (q === 'off') {
        disposeComposer();
        patchRaw(false);
      } else {
        build(q);
        patchRaw(true);
      }
    },
    dispose() {
      disposeComposer();
      patchRaw(false);
      q = 'off';
    },
  };
  api.setQuality(quality);
  return api;
}
