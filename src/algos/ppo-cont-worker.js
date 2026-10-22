// Sürekli PPO gradyan güncellemelerini ayrı bir CPU çekirdeğinde çalıştıran Web Worker.
import { PPOContLearner } from './ppo-cont-core.js';

let learner = null;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    learner = new PPOContLearner(m.sizesPi, m.sizesV, m.pi, m.v, m.lr, m.seed);
  } else if (m.type === 'state') {
    if (learner) learner.setState(m.state);
  } else if (m.type === 'update') {
    const t0 = performance.now();
    const stats = learner.update(m.batch, m.hp);
    stats.ms = performance.now() - t0;
    const st = learner.getState();
    self.postMessage({ type: 'result', epoch: m.epoch, state: st, stats }, [st.pi.buffer, st.v.buffer, st.adamPi.m.buffer, st.adamPi.v.buffer, st.adamV.m.buffer, st.adamV.v.buffer]);
  }
};
