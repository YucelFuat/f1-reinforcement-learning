// ZIP yazıcı testi (src/exporter.js makeZip): kendi küçük okuyucumuzla yerel başlıklar, merkezi dizin,
// dizin sonu kaydı ve CRC-32 doğrulanır. Sıkıştırma yok (yöntem 0), dosya adları UTF-8.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeZip } from '../src/exporter.js';

// bağımsız CRC-32 (bit bit; exporter'daki tablo yöntemiyle aynı sonucu vermeli)
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function readZip(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const dec = new TextDecoder('utf-8', { fatal: true });
  // dizin sonu kaydı (yorum yok → son 22 bayt)
  const eocd = u8.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50, 'dizin sonu imzası');
  const count = dv.getUint16(eocd + 10, true);
  assert.equal(dv.getUint16(eocd + 8, true), count);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOff = dv.getUint32(eocd + 16, true);
  assert.equal(cdOff + cdSize, eocd, 'merkezi dizin, dizin sonundan hemen önce');
  const files = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50, 'merkezi dizin imzası');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    // yerel başlık
    assert.equal(dv.getUint32(lho, true), 0x04034b50, `yerel başlık imzası (${name})`);
    assert.equal(dv.getUint16(lho + 6, true), flags);
    assert.equal(dv.getUint16(lho + 8, true), method);
    assert.equal(dv.getUint32(lho + 14, true), crc, 'yerel ve merkezi CRC aynı');
    assert.equal(dv.getUint32(lho + 18, true), csize);
    assert.equal(dv.getUint32(lho + 22, true), usize);
    const lnlen = dv.getUint16(lho + 26, true);
    const lelen = dv.getUint16(lho + 28, true);
    assert.equal(dec.decode(u8.subarray(lho + 30, lho + 30 + lnlen)), name, 'yerel ve merkezi ad aynı');
    const data = u8.slice(lho + 30 + lnlen + lelen, lho + 30 + lnlen + lelen + csize);
    files.push({ name, flags, method, crc, csize, usize, data });
  }
  assert.equal(p, cdOff + cdSize);
  return files;
}

test('makeZip: geçerli ZIP; adlar, boyutlar, CRC-32 ve içerik doğru', async () => {
  const bin = new Uint8Array(1000);
  for (let i = 0; i < bin.length; i++) bin[i] = (i * 37 + 11) & 255;
  const input = [
    { name: 'telemetri.csv', data: 'zaman_s,hiz_kmh\r\n0,0\r\n0.0167,1.2\r\n' },
    { name: 'eğitim_geçmişi_ışık.txt', data: 'Türkçe karakterler: ç ğ ı İ ö ş ü' },
    { name: 'veri/ikili.bin', data: bin },
    { name: 'bos.txt', data: '' },
  ];
  const blob = makeZip(input);
  assert.equal(blob.type, 'application/zip');
  const files = readZip(await blob.arrayBuffer());
  assert.equal(files.length, input.length);
  const enc = new TextEncoder();
  input.forEach((f, i) => {
    const want = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const got = files[i];
    assert.equal(got.name, f.name);
    assert.equal(got.method, 0, 'sıkıştırmasız');
    assert.ok(got.flags & 0x0800, 'UTF-8 ad bayrağı');
    assert.equal(got.usize, want.length);
    assert.equal(got.csize, want.length);
    assert.deepEqual(got.data, want);
    assert.equal(got.crc, crc32(want), `CRC (${f.name})`);
  });
  // bilinen CRC-32 değeri ("123456789" → CBF43926)
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
});

test('makeZip: boş arşiv de geçerli', async () => {
  const files = readZip(await makeZip([]).arrayBuffer());
  assert.equal(files.length, 0);
});
