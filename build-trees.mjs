#!/usr/bin/env node
/*
  build-trees.mjs  —  Bags on trees
  ------------------------------------------------------------------
  Downloads every living street tree from NYC Open Data ONCE, lays the
  dots out (same spacing logic the page uses), and writes the small
  files the page loads instead of calling NYC's API on every visit.

  Run it about every 3 months (or when NYC publishes a new census):

      node build-trees.mjs                 -> writes ./tree-data/
      node build-trees.mjs my-folder       -> writes ./my-folder/
      node build-trees.mjs --stable        -> fixed names (trees.bin ...), so page links never change
      node build-trees.mjs --ext=txt       -> names every file .txt
                                              (use this if Cargo refuses .bin / .json uploads)

  Needs Node 18 or newer (check with: node --version). No installs.
  Takes a few minutes. Optional: set SOCRATA_APP_TOKEN to avoid NYC rate limits.

  Output (dated, so Cargo never complains about duplicate file names):
      trees-YYYY-MM.bin            dot positions + species  (~12 MB)
      trees-species-YYYY-MM.json   species list             (small)
      trees-addresses-YYYY-MM.txt  street addresses for hover cards (optional, loads in background)
*/
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const API = process.env.NYC_API || 'https://data.cityofnewyork.us/resource/uvpi-gqnh.json';
const args = process.argv.slice(2);
const outDir = args.find(a => !a.startsWith('--')) || './tree-data';
const extOverride = (args.find(a => a.startsWith('--ext=')) || '').slice(6);
const PAGE = 50000;
const FIELDS = 'latitude,longitude,spc_common,spc_latin,address,zipcode,zip_city';

// Must match the page (bags-on-trees.html)
const NYC_CENTER = { lat: 40.72, lon: -73.97 };
const SCALE_FACTOR = 12000;
const MIN_GAP_WORLD = 14;
const RELAX_ITERATIONS = 4;
const BIN_MAGIC = 0x42414754;   // "TGAB"
const BIN_BYTES_PER_TREE = 18;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchPage(offset) {
  const q = [
    `$select=${FIELDS}`,
    `$where=${encodeURIComponent("status='Alive' AND latitude IS NOT NULL")}`,
    `$order=:id`,                    // stable order, so pages never overlap or skip
    `$limit=${PAGE}`,
    `$offset=${offset}`,
  ].join('&');
  const headers = process.env.SOCRATA_APP_TOKEN ? { 'X-App-Token': process.env.SOCRATA_APP_TOKEN } : {};
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${API}?${q}`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt === 4) throw e;
      console.warn(`  page at offset ${offset} failed (${e.message}) — retrying…`);
      await sleep(1500 * attempt);
    }
  }
}

async function main() {
  console.log('Downloading NYC street trees…');
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const batch = await fetchPage(offset);
    for (const r of batch) {
      const lat = parseFloat(r.latitude), lon = parseFloat(r.longitude);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      rows.push({
        lat, lon,
        c: (r.spc_common || 'unknown').trim() || 'unknown',
        l: (r.spc_latin || '').trim(),
        address: String(r.address || '').replace(/[\t\r\n]+/g, ' ').trim(),
        city: String(r.zip_city || '').replace(/[\t\r\n]+/g, ' ').trim(),
        zip: String(r.zipcode || '').replace(/[\t\r\n]+/g, ' ').trim(),
      });
    }
    console.log(`  ${rows.length.toLocaleString()} trees`);
    if (batch.length < PAGE) break;
    await sleep(150);
  }
  const N = rows.length;
  if (N < 100000) throw new Error(`Only ${N} trees came back — something went wrong. Nothing was written.`);

  // Project to page "world" coordinates
  const wx = new Float64Array(N), wy = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    wx[i] = (rows[i].lon - NYC_CENTER.lon) * SCALE_FACTOR;
    wy[i] = (NYC_CENTER.lat - rows[i].lat) * SCALE_FACTOR;
  }

  // Spread overlapping dots apart (same rule as the page's relaxTreePositions)
  console.log('Spacing the dots…');
  const CELL = MIN_GAP_WORLD * 2;
  const keyOf = (x, y) => (Math.floor(x / CELL) + 20000) * 40000 + (Math.floor(y / CELL) + 20000);
  for (let iter = 0; iter < RELAX_ITERATIONS; iter++) {
    const cells = new Map();
    for (let i = 0; i < N; i++) {
      const k = keyOf(wx[i], wy[i]);
      const c = cells.get(k);
      if (c) c.push(i); else cells.set(k, [i]);
    }
    let moved = 0;
    for (let i = 0; i < N; i++) {
      const cx = Math.floor(wx[i] / CELL) + 20000, cy = Math.floor(wy[i] / CELL) + 20000;
      let dxs = 0, dys = 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const cell = cells.get((cx + ox) * 40000 + (cy + oy));
        if (!cell) continue;
        for (const j of cell) {
          if (j === i) continue;
          const dx = wx[i] - wx[j], dy = wy[i] - wy[j];
          const d2 = dx * dx + dy * dy;
          if (d2 < MIN_GAP_WORLD * MIN_GAP_WORLD && d2 > 0.0001) {
            const d = Math.sqrt(d2);
            const push = (MIN_GAP_WORLD - d) * 0.5;
            dxs += (dx / d) * push; dys += (dy / d) * push;
          }
        }
      }
      if (dxs !== 0 || dys !== 0) { wx[i] += dxs; wy[i] += dys; moved++; }
    }
    console.log(`  pass ${iter + 1}: moved ${moved.toLocaleString()}`);
    if (moved < N * 0.01) break;
  }

  // Species list + city list
  const speciesIdx = new Map(), speciesArr = [];
  const cityIdx = new Map(), cityArr = [];
  const buf = Buffer.alloc(12 + N * BIN_BYTES_PER_TREE);
  buf.writeUInt32LE(BIN_MAGIC, 0);
  buf.writeUInt32LE(1, 4);
  buf.writeUInt32LE(N, 8);
  const addrLines = new Array(N);
  let off = 12;
  for (let i = 0; i < N; i++) {
    const r = rows[i];
    const sk = `${r.c}|${r.l}`;
    let si = speciesIdx.get(sk);
    if (si === undefined) { si = speciesArr.length; speciesIdx.set(sk, si); speciesArr.push({ c: r.c, l: r.l }); }
    let ci = cityIdx.get(r.city);
    if (ci === undefined) { ci = cityArr.length; cityIdx.set(r.city, ci); cityArr.push(r.city); }
    buf.writeFloatLE(wx[i], off); off += 4;
    buf.writeFloatLE(wy[i], off); off += 4;
    buf.writeFloatLE(r.lat, off); off += 4;
    buf.writeFloatLE(r.lon, off); off += 4;
    buf.writeUInt16LE(si, off); off += 2;
    addrLines[i] = `${r.address}\t${ci}\t${r.zip}`;
  }
  if (speciesArr.length > 65535) throw new Error('Too many species for the file format');

  // Write files
  mkdirSync(outDir, { recursive: true });
  const d = new Date();
  const stamp = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const ext = e => extOverride || e;
  const stable = args.includes('--stable');   // fixed file names, so the links in the page never need editing
  const tag = stable ? '' : `-${stamp}`;
  const names = {
    bin: `trees${tag}.${ext('bin')}`,
    spc: `trees-species${tag}.${ext('json')}`,
    adr: `trees-addresses${tag}.${ext('txt')}`,
  };
  writeFileSync(join(outDir, names.bin), buf);
  writeFileSync(join(outDir, names.spc), JSON.stringify(speciesArr));
  writeFileSync(join(outDir, names.adr),
    `TREES\t${N}\n${JSON.stringify(cityArr)}\n${addrLines.join('\n')}\n`);

  const mb = x => (x / 1e6).toFixed(1) + ' MB';
  console.log(`\nDone — ${N.toLocaleString()} trees, ${speciesArr.length} species.`);
  console.log(`Files are in ${outDir}:`);
  console.log(`  ${names.bin}   ${mb(buf.length)}`);
  console.log(`  ${names.spc}`);
  console.log(`  ${names.adr}`);
  console.log(`\nNext: upload the three files, then in bags-on-trees.html paste their links into the DATA block:\n`);
  console.log(`const DATA = {
  treesBin:       '<link to ${names.bin}>',
  treesSpecies:   '<link to ${names.spc}>',
  treesAddresses: '<link to ${names.adr}>',
  version:        '${stamp}',
  maxAgeDays:     90,
};`);
}

main().catch(e => { console.error('\nFailed:', e.message); process.exit(1); });
