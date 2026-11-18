// Saves a copy of the Are.na channel as bags.json, so the page still has the bags when a phone/browser
// cannot reach Are.na directly. Run by .github/workflows/refresh-bags.yml every few hours.
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
const SLUG = 'bags-on-trees';
const blocks = [];
for (let page = 1; page <= 30; page++) {
  const res = await fetch(`https://api.are.na/v2/channels/${SLUG}/contents?per=100&page=${page}`, { headers: { 'User-Agent': 'bags-on-trees-snapshot' } });
  if (!res.ok) { console.error('Are.na answered HTTP', res.status); process.exit(1); }
  const data = await res.json();
  for (const b of data.contents) blocks.push({
    id: b.id, title: b.title, generated_title: b.generated_title, description: b.description,
    attachment: b.attachment ? { url: b.attachment.url } : null,
    image: b.image ? { large: b.image.large, display: b.image.display, original: b.image.original, thumb: b.image.thumb, square: b.image.square } : null,
  });
  if (data.contents.length < 100) break;
}
if (!blocks.length) { console.error('Are.na returned no blocks - keeping the old snapshot'); process.exit(1); }
const out = JSON.stringify(blocks);
if (existsSync('bags.json') && readFileSync('bags.json', 'utf8') === out) { console.log('No change'); process.exit(0); }
writeFileSync('bags.json', out);
console.log('Saved', blocks.length, 'blocks');
