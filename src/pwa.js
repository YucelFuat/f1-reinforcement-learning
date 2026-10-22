// PWA: servis çalışanını kaydeder, "Uygulamayı yükle" düğmesini yönetir, bağımsız pencerede çalışıp çalışmadığını bildirir.
//
// Kullanım (main.js):
//   import { initPWA } from './pwa.js';
//   const pwa = initPWA({ installButton: document.getElementById('btnInstall') });
//   pwa.isStandalone  → true: yüklenmiş uygulama penceresinde (veya --app ile) açık
//
// Servis çalışanı yalnızca http(s) üzerinde kaydedilir (file:// ile açılınca sessizce atlanır).
// Önbellek stratejisi sw.js içinde: her zaman önce ağ, ağ yoksa önbellek → geliştirmede eski kod görülmez.

function detectStandalone() {
  try {
    if (navigator.standalone === true) return true; // iOS Safari
    return ['standalone', 'window-controls-overlay', 'fullscreen', 'minimal-ui'].some((m) => matchMedia(`(display-mode: ${m})`).matches);
  } catch {
    return false;
  }
}

export function initPWA({ installButton = null, swUrl = 'sw.js', onChange = null } = {}) {
  const state = {
    supported: false,       // servis çalışanı kaydedilebildi mi
    registration: null,
    ready: Promise.resolve(null),
    isStandalone: detectStandalone(),
    canInstall: false,      // tarayıcı yükleme önerisi verdi mi (beforeinstallprompt)
    installed: false,
    crossOriginIsolated: !!globalThis.crossOriginIsolated,
    install: async () => false,
  };
  const emit = () => {
    if (installButton) installButton.hidden = !state.canInstall || state.isStandalone;
    if (onChange) {
      try { onChange(state); } catch (e) { console.error(e); }
    }
  };

  const proto = location.protocol;
  const httpLike = proto === 'http:' || proto === 'https:';
  if (httpLike && 'serviceWorker' in navigator && window.isSecureContext) {
    state.supported = true;
    state.ready = navigator.serviceWorker
      .register(swUrl, { scope: './' })
      .then((reg) => {
        state.registration = reg;
        return reg;
      })
      .catch((err) => {
        console.warn('Servis çalışanı kaydedilemedi:', err);
        state.supported = false;
        return null;
      });
  }

  let deferred = null;
  if (installButton) {
    installButton.hidden = true;
    installButton.addEventListener('click', () => state.install());
  }

  state.install = async () => {
    if (!deferred) return false;
    const ev = deferred;
    deferred = null;
    state.canInstall = false;
    emit();
    try {
      await ev.prompt();
      const choice = await ev.userChoice;
      return choice && choice.outcome === 'accepted';
    } catch (e) {
      console.warn('Yükleme penceresi açılamadı:', e);
      return false;
    }
  };

  window.addEventListener('beforeinstallprompt', (e) => {
    // tarayıcının kendi küçük bilgi çubuğu yerine kendi düğmemizi göster
    e.preventDefault();
    deferred = e;
    state.canInstall = true;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    state.canInstall = false;
    state.installed = true;
    emit();
  });
  try {
    matchMedia('(display-mode: standalone)').addEventListener('change', () => {
      state.isStandalone = detectStandalone();
      emit();
    });
  } catch {
    /* eski tarayıcı */
  }
  emit();
  return state;
}
