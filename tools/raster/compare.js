// Baseline regression: run every tools/raster/req-*.txt through the .NET build
// and the Go build, then compare their JSON item by item.
//
//   node tools/raster/compare.js            # Go vs stored res-*.json
//   node tools/raster/compare.js --old      # .NET vs stored, then Go vs .NET
//
// Numeric fields are compared with a tolerance, strings exactly.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const dir = __dirname;
const tmp = path.join(os.tmpdir(), 'balloonist-cmp');
fs.mkdirSync(tmp, { recursive: true });

function readRequest(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const out = { img: null, mode: 'frames', rects: 0 };
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t[0] === '#') continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim().toLowerCase();
    const v = t.slice(eq + 1).trim();
    if (k === 'img') out.img = v;
    else if (k === 'mode') out.mode = v.toLowerCase();
    else if (k === 'rect') out.rects++;
  }
  return out;
}

function run(bin, req, res) {
  try { fs.unlinkSync(res); } catch {}
  try {
    execFileSync(bin, [req, res], { stdio: 'pipe', timeout: 180000 });
  } catch (e) {
    return { error: (e.stderr || e.message || '').toString().trim().slice(0, 200) };
  }
  if (!fs.existsSync(res)) return { error: 'no result file' };
  try { return { data: JSON.parse(fs.readFileSync(res, 'utf8')) }; }
  catch (e) { return { error: 'unparsable result: ' + e.message }; }
}

const TOL = 1e-6;
function diffValues(a, b, where, out) {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Math.abs(a - b) > TOL) out.push(`${where}: ${a} != ${b}`);
    return;
  }
  if (typeof a === 'string' || typeof b === 'string') {
    if (a !== b) out.push(`${where}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { out.push(`${where}: length ${a.length} != ${b.length}`); return; }
    for (let i = 0; i < a.length; i++) diffValues(a[i], b[i], `${where}[${i}]`, out);
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a)) { out.push(`${where}.${k}: missing in A`); continue; }
      if (!(k in b)) { out.push(`${where}.${k}: missing in B`); continue; }
      diffValues(a[k], b[k], `${where}.${k}`, out);
    }
    return;
  }
  if (a !== b) out.push(`${where}: ${String(a)} != ${String(b)}`);
}

function itemsOf(json) {
  if (Array.isArray(json.results)) return json.results;
  if (Array.isArray(json.bubbles)) return json.bubbles;
  return [];
}

const reqs = fs.readdirSync(dir).filter(f => f.endsWith('.txt') && f.startsWith('req')).sort();
// compare the freshly built Windows binary against the recorded baselines
const newBin = process.argv.find(a => a.startsWith('--bin='))?.slice(6) || path.join(dir, 'BalloonistRaster.exe');
// optional reference: the retired .NET build, kept aside for A/B runs
const oldBin = process.env.BALLOONIST_DOTNET || path.join(dir, 'BalloonistRaster-dotnet.exe');
const withOld = process.argv.includes('--old') && fs.existsSync(oldBin);
const only = process.argv.find(a => a.startsWith('--only='));

let pass = 0, fail = 0, skipped = 0;
const failures = [];

for (const reqName of reqs) {
  const base = reqName.replace(/^req-?/, '').replace(/\.txt$/, '') || 'root';
  const reqPath = path.join(dir, reqName);
  const rq = readRequest(reqPath);
  if (!rq.img || !fs.existsSync(rq.img)) { skipped++; continue; }
  const storedName = `res-${base}.json`;
  const storedPath = path.join(dir, storedName);
  const hasStored = fs.existsSync(storedPath);

  const newRes = path.join(tmp, `new-${base}.json`);
  const newRun = run(newBin, reqPath, newRes);
  if (newRun.error) { fail++; failures.push([base, [`go: ${newRun.error}`]]); continue; }

  const refLabel = hasStored ? storedName : (withOld ? '.NET' : null);
  let refData = null;
  if (hasStored) refData = JSON.parse(fs.readFileSync(storedPath, 'utf8'));

  if (withOld && fs.existsSync(oldBin)) {
    const oldRes = path.join(tmp, `old-${base}.json`);
    const oldRun = run(oldBin, reqPath, oldRes);
    if (oldRun.error) { fail++; failures.push([base, [`dotnet: ${oldRun.error}`]]); continue; }
    const d = [];
    diffValues(refData, oldRun.data, 'res', d);
    if (d.length) failures.push([base + ' [stored vs .NET]', d.slice(0, 12)]);
    refData = oldRun.data;
  }

  if (!refData) { skipped++; continue; }
  const d = [];
  diffValues(refData, newRun.data, 'res', d);
  if (d.length) { fail++; failures.push([base, d.slice(0, 12)]); }
  else {
    pass++;
    console.log(`OK   ${base.padEnd(12)} items=${itemsOf(newRun.data).length} mode=${newRun.data.mode || 'frames'}`);
  }
}

for (const [name, d] of failures) {
  console.log(`FAIL ${name}`);
  for (const line of d) console.log(`     ${line}`);
}
console.log(`\npass=${pass} fail=${fail} skipped=${skipped}`);
process.exit(fail ? 1 : 0);
