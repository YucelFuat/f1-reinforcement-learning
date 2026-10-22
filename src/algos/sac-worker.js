// SAC gradyan adımlarını ayrı bir CPU çekirdeğinde çalıştıran Web Worker (tekrar belleği de burada tutulur).
import { SACLearner } from './sac-core.js';

let learner = null;

function transferList(st) {
  return [
    st.actor.buffer, st.q1.buffer, st.q2.buffer, st.q1t.buffer, st.q2t.buffer,
    st.adamA.m.buffer, st.adamA.v.buffer, st.adamQ1.m.buffer, st.adamQ1.v.buffer, st.adamQ2.m.buffer, st.adamQ2.v.buffer,
  ];
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    learner = new SACLearner(m.init);
  } else if (m.type === 'state') {
    if (learner) learner.setState(m.state);
  } else if (m.type === 'round') {
    const t0 = performance.now();
    if (m.batch && m.batch.n) learner.add(m.batch);
    const stats = learner.train(m.steps, m.hp, m.norm);
    stats.ms = performance.now() - t0;
    // durum yalnızca gradyan adımı atıldıysa gönderilir (ısınma sırasında gereksiz kopya yok)
    const st = stats.steps > 0 ? learner.getState() : null;
    self.postMessage({ type: 'result', epoch: m.epoch, state: st, stats }, st ? transferList(st) : []);
  }
};
