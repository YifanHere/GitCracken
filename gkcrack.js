#!/usr/bin/env node
/**
 * gkcrack.js — GitKraken Desktop 12.x local license unlock (test fixture / offline lab use)
 *
 * What it does
 *   GitKraken 12.x derives every paid gate from the redux selector `getLicensedFeatures`
 *   (app state: appSettings.licensedFeatures).  The selector exists in three webpack
 *   bundles shipped inside resources/app.asar:
 *       src/main/static/main.bundle.js
 *       src/render/static/entryPoints/main/render.bundle.js
 *       src/render/static/entryPoints/requestHandler/requestHandler.bundle.js
 *   This tool rewrites the selector's result function to `()=>["advanced"]` in place,
 *   keeping the byte length identical, so the ASAR header/offsets stay valid and no
 *   repack is required.
 *
 * Usage (Windows, GitKraken closed):
 *   node gkcrack.js --check      # report only
 *   node gkcrack.js              # patch (creates app.asar.bak-before-gitcracken once)
 *   node gkcrack.js --revert     # restore app.asar.bak-before-gitcracken
 *
 * Notes
 *   - Re-run after every GitKraken update (a new app-X.Y.Z folder is a fresh, unpatched asar).
 *   - Works with an extracted `resources/app` folder too: the same edit is mirrored there.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PREFIX = 'getLicensedFeatures=(0,';
const SELECTOR_RE =
  /getLicensedFeatures=\(0,[\w$]+\.createSelector\)\(getAppSettings,\(\(\{licensedFeatures:([\w$]+)\}\)=>\1\)\)/;
const INNER_RE = /\(\(\{licensedFeatures:([\w$]+)\}\)=>\1\)/;
const PATCHED_MARK = '(()=>["advanced"]';

const BUNDLES = [
  'src/main/static/main.bundle.js',
  'src/render/static/entryPoints/main/render.bundle.js',
  'src/render/static/entryPoints/requestHandler/requestHandler.bundle.js',
];

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const REVERT = args.has('--revert');
const NO_BACKUP = args.has('--no-backup');

function log(...a) {
  console.log(...a);
}

function findResources() {
  const override = process.env.GK_RESOURCES;
  if (override) return override;
  const base =
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'gitkraken')
      : process.platform === 'darwin'
        ? '/Applications/GitKraken.app/Contents/Resources'
        : '/opt/gitkraken/resources';
  if (!fs.existsSync(base)) throw new Error(`GitKraken install not found: ${base}`);
  const versions = fs
    .readdirSync(base)
    .filter((n) => /^app-\d+\.\d+\.\d+$/.test(n))
    .sort((a, b) => {
      const pa = a.slice(4).split('.').map(Number);
      const pb = b.slice(4).split('.').map(Number);
      for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
      return 0;
    });
  if (!versions.length) throw new Error(`No app-X.Y.Z folder in ${base}`);
  return path.join(base, versions[versions.length - 1], 'resources');
}

function makeReplacement(inner) {
  const head = PATCHED_MARK;
  const pad = inner.length - head.length - 1;
  if (pad < 0) throw new Error(`selector too short to patch: ${inner}`);
  return head + ' '.repeat(pad) + ')';
}

/** Stream the asar and return [{offset, selector}] hits. */
function scanAsar(asarPath) {
  const size = fs.statSync(asarPath).size;
  const fd = fs.openSync(asarPath, 'r');
  const CHUNK = 16 * 1024 * 1024;
  const OVERLAP = 1024;
  let pos = 0;
  let carry = Buffer.alloc(0);
  const hits = [];
  let patched = 0;
  try {
    while (pos < size) {
      const buf = Buffer.allocUnsafe(CHUNK);
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      const data = Buffer.concat([carry, buf.subarray(0, n)]);
      const base = pos - carry.length;
      patched += countOccurrences(data, PATCHED_MARK);
      let i = -1;
      while ((i = data.indexOf(PREFIX, i + 1)) !== -1) {
        const win = data.subarray(i, Math.min(data.length, i + 300)).toString('latin1');
        const m = SELECTOR_RE.exec(win);
        if (m) hits.push({offset: base + i, selector: m[0]});
      }
      carry = data.subarray(Math.max(0, data.length - OVERLAP));
      pos += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return {hits, patched};
}

function countOccurrences(buf, needle) {
  const nd = Buffer.from(needle, 'latin1');
  let n = 0;
  let i = -1;
  while ((i = buf.indexOf(nd, i + 1)) !== -1) n++;
  return n;
}

function patchFile(file, dryRun) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {found: 0, patched: 0};
  }
  let found = 0;
  const out = text.replace(new RegExp(SELECTOR_RE.source, 'g'), (whole) => {
    found++;
    const inner = INNER_RE.exec(whole)[0];
    return whole.replace(inner, makeReplacement(inner));
  });
  if (!dryRun && found) fs.writeFileSync(file, out, 'utf8');
  return {found, patched: countOccurrences(Buffer.from(out, 'utf8'), PATCHED_MARK)};
}

function main() {
  const resources = findResources();
  const asar = path.join(resources, 'app.asar');
  const appDir = path.join(resources, 'app');
  const backup = `${asar}.bak-before-gitcracken`;
  log(`resources : ${resources}`);
  log(`asar      : ${asar} (${fs.statSync(asar).size} bytes)`);

  if (REVERT) {
    if (!fs.existsSync(backup)) throw new Error(`backup not found: ${backup}`);
    fs.copyFileSync(backup, asar);
    for (const rel of BUNDLES) {
      const p = path.join(appDir, rel);
      if (fs.existsSync(p) && fs.existsSync(backup)) {
        // app dir mirror: leave as is, the asar is authoritative
      }
    }
    log('reverted app.asar from backup');
    return;
  }

  const {hits, patched} = scanAsar(asar);
  log(`selector hits: ${hits.length}   already-patched markers: ${patched}`);
  for (const h of hits) log(`  @${h.offset}  ${h.selector.slice(0, 120)}`);

  if (!hits.length) {
    if (patched) {
      log('nothing to do: selector already patched');
    } else {
      log('pattern not found — this GitKraken build changed; inspect getLicensedFeatures manually');
    }
    return;
  }

  if (CHECK) {
    log('check only, no writes (run without --check to patch)');
    return;
  }

  if (!NO_BACKUP && !fs.existsSync(backup)) {
    log(`backup -> ${backup}`);
    fs.copyFileSync(asar, backup);
  }

  const fd = fs.openSync(asar, 'r+');
  try {
    for (const h of hits) {
      const rep = h.selector.replace(INNER_RE.exec(h.selector)[0], makeReplacement(INNER_RE.exec(h.selector)[0]));
      const repBuf = Buffer.from(rep, 'utf8');
      if (repBuf.length !== Buffer.byteLength(h.selector, 'utf8')) {
        throw new Error('internal error: replacement length mismatch');
      }
      fs.writeSync(fd, repBuf, 0, repBuf.length, h.offset);
      log(`  patched asar @${h.offset}`);
    }
  } finally {
    fs.closeSync(fd);
  }

  if (fs.existsSync(appDir)) {
    for (const rel of BUNDLES) {
      const r = patchFile(path.join(appDir, rel), false);
      if (r.found) log(`  patched app dir ${rel}`);
    }
  }

  const verify = scanAsar(asar);
  log(`verify: remaining selectors=${verify.hits.length}, patched markers=${verify.patched}`);
  if (verify.patched !== hits.length) throw new Error('verification failed');
  log('done — start GitKraken, the status bar should show ADVANCED instead of COMMUNITY');
}

main();
