// Test çalıştırıcı:  npm test   (= node tests/run.js)
//                    npm run test:fast            → yavaş testleri atla
//                    node tests/run.js physics    → yalnızca adında "physics" geçen dosyalar
//
// Neden `node --test tests/` değil? Node 22 klasör argümanını kabul etmiyor (glob ister), Node 18/20 ise glob
// desteklemiyor. Bu betik dosyaları kendisi bulup `node --test dosya1 dosya2 …` çalıştırır → her sürümde ve
// Windows/macOS/Linux'ta aynı şekilde çalışır.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const fast = args.includes('--fast');
const passThrough = args.filter((a) => a.startsWith('--test-'));
const filters = args.filter((a) => !a.startsWith('--'));

let files = readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();
if (filters.length) files = files.filter((f) => filters.some((q) => f.includes(q)));
if (!files.length) {
  console.error('Eşleşen test dosyası yok.');
  process.exit(1);
}
const env = { ...process.env };
if (fast) env.RL_FAST = '1';
console.log(`${files.length} test dosyası çalıştırılıyor${fast ? ' (yavaş testler atlanıyor)' : ''}: ${files.join(', ')}\n`);
const r = spawnSync(process.execPath, ['--test', ...passThrough, ...files.map((f) => path.join(dir, f))], { stdio: 'inherit', env });
process.exit(r.status ?? 1);
