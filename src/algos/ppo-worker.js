// PPO gradyan güncellemelerini ayrı bir CPU çekirdeğinde çalıştıran Web Worker.
import { PPOLearner } from './ppo-core.js';

let learner = null;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    learner = new PPOLearner(m.sizesPi, m.sizesV, m.pi, m.v, m.lr, m.seed);
  } else if (m.type === 'set') {
    if (learner) learner.setParams(m.pi, m.v);
  } else if (m.type === 'state') {
    if (learner) learner.setState(m.state);
  } else if (m.type === 'update') {
    const t0 = performance.now();
    const stats = learner.update(m.batch, m.hp);
    stats.ms = performance.now() - t0;
    // tam öğrenici durumu (Adam momentleri dahil) → ana iş parçacığı getState() için saklar
    const st = learner.getState();
    self.postMessage({ type: 'result', id: m.id, epoch: m.epoch, pi: st.pi, v: st.v, state: st, stats }, [st.pi.buffer, st.v.buffer, st.adamPi.m.buffer, st.adamPi.v.buffer, st.adamV.m.buffer, st.adamV.v.buffer]);
  }
};
