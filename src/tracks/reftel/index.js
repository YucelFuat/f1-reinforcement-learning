// Gerçek dünya referans telemetrisi (5 m aralıklı): her pist için tek bir hızlı yarış turu.
// Kaynak: TracingInsights genel F1 telemetri arşivi (https://github.com/TracingInsights, Apache-2.0),
// F1 resmi zamanlama verisinden. Yollar site köküne göredir; uygulama fetch() ile yükler.
export const REF_TELEMETRY = {
  austin: 'src/tracks/reftel/austin.json',
  istanbul: 'src/tracks/reftel/istanbul.json',
  monza: 'src/tracks/reftel/monza.json',
  spa: 'src/tracks/reftel/spa.json',
  silverstone: 'src/tracks/reftel/silverstone.json',
};
