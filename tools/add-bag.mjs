#!/usr/bin/env node
/* Fast pipeline: raw iPhone video(s) -> the site, in one command.
   Usage:   node tools/add-bag.mjs IMG_5402.mov IMG_5420.mov [--address "184 Kent Ave"] [--push]
   For each video it
     1. reads the date, time and GPS the phone stored inside the file,
     2. finds the street address from the GPS (OpenStreetMap; or pass --address, or it uses a plain "Brooklyn, NY" you can fix in local-bags.json),
     3. makes a light version (SDR H.264, ~1-3 MB) + a poster picture in videos/,
     4. adds it to local-bags.json, which the site reads on every visit,
     5. with --push: commits and pushes, so it is live on GitHub Pages about a minute later.
   Needs ffmpeg + ffprobe, and git for --push. Re-running a file replaces its entry. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, v && !v.startsWith('--') ? 2 : 1); return v && !v.startsWith('--') ? v : true; };
const addressArg = flag('--address'), push = flag('--push');
const files = args.filter(a => !a.startsWith('--'));
if (!files.length) { console.error('Give me one or more video files.'); process.exit(1); }

const jsonPath = resolve(root, 'local-bags.json');
const list = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, 'utf8')) : [];
mkdirSync(resolve(root, 'videos'), { recursive: true });

async function streetFrom(lat, lon) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${lat}&lon=${lon}`, { headers: { 'User-Agent': 'bags-on-trees-pipeline' } });
    const a = (await r.json()).address || {};
    const street = [a.house_number, a.road].filter(Boolean).join(' ');
    if (street) return `${street}, Brooklyn, NY`.replace('Brooklyn', a.borough || a.suburb && /Brooklyn/.test(a.county || '') ? 'Brooklyn' : (a.city || 'Brooklyn'));
  } catch (e) {}
  return null;
}

for (const f of files) {
  const name = basename(f, extname(f)), num = (name.match(/IMG[_-]?(\d+)/i) || name.match(/(\d+)(?!.*\d)/) || [, name])[1];
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', f]).toString());
  const tg = probe.format.tags || {};
  const when = tg['com.apple.quicktime.creationdate'] || '';   // e.g. 2026-11-21T13:42:14-0500 (the phone's own clock)
  const m = when.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  const g = (tg['com.apple.quicktime.location.ISO6709'] || '').match(/^([+-]\d+\.\d+)([+-]\d+\.\d+)/);
  if (!m || !g) { console.error(`${f}: no date/GPS inside the file - skipped`); continue; }
  const lat = parseFloat(g[1]), lon = parseFloat(g[2]);
  const address = (files.length === 1 && addressArg) || (await streetFrom(lat, lon)) || 'Brooklyn, NY';
  const mp4 = `videos/IMG_${num}.mp4`, jpg = `videos/IMG_${num}.jpg`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', f, '-vf', 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,scale=-2:1080',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-maxrate', '4M', '-bufsize', '8M', '-r', '30', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', resolve(root, mp4)]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '1', '-i', resolve(root, mp4), '-frames:v', '1', '-vf', 'scale=540:-2', '-q:v', '4', resolve(root, jpg)]);
  const entry = { id: `local-${num}`, title: num, date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}`, lat, lon, address, video: mp4, image: jpg };
  const i = list.findIndex(e => e.id === entry.id); if (i >= 0) list[i] = entry; else list.push(entry);
  console.log(`${name}: ${entry.date} ${entry.time}  ${address}  (${lat}, ${lon})`);
}
writeFileSync(jsonPath, JSON.stringify(list, null, 2) + '\n');
if (push) {
  execFileSync('git', ['add', 'local-bags.json', 'videos'], { cwd: root, stdio: 'inherit' });
  execFileSync('git', ['commit', '-m', `Add ${files.length} bag video(s)`], { cwd: root, stdio: 'inherit' });
  execFileSync('git', ['push'], { cwd: root, stdio: 'inherit' });
  console.log('Pushed. Live in about a minute.');
} else console.log('Done. Review local-bags.json, then commit + push (or re-run with --push).');
