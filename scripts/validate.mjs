#!/usr/bin/env node
/**
 * Static validation for the unpacked extension.
 *
 * Checks the things that otherwise only show up as a mysterious "Could not load
 * extension" in edge://extensions:
 *   - manifest is valid JSON and has the keys MV3 requires
 *   - every file the manifest references exists
 *   - content scripts are listed in dependency order
 *   - host permissions cover every content-script host
 *   - every JS file parses (as an ES module, which also accepts classic scripts)
 *   - every relative import inside an ES module resolves
 *   - no eval / new Function, no inline <script> in the HTML (MV3 CSP)
 *   - every <use href="#i-x"> icon exists as a <symbol id="i-x">
 *
 * Usage: node scripts/validate.mjs
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EXT = path.join(ROOT, 'extension');

const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll('\\', '/');
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/* ─────────────────────────────── manifest ─────────────────────────────── */

const manifestPath = path.join(EXT, 'manifest.json');
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (error) {
  console.error(`✗ manifest.json is not valid JSON: ${error.message}`);
  process.exit(1);
}

if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
if (!manifest.name) fail('manifest.name is missing');
if (!/^\d+(\.\d+){0,3}$/.test(String(manifest.version || ''))) fail('manifest.version must be numeric');
if (!manifest.action) fail('manifest.action is missing (the toolbar button)');
if (!manifest.background?.service_worker) fail('manifest.background.service_worker is missing');
if (manifest.background?.type !== 'module') fail('background.type should be "module" for ESM imports');

const referenced = new Set();
const addRef = (value) => {
  if (typeof value === 'string' && value.trim()) referenced.add(value.trim());
};

Object.values(manifest.icons || {}).forEach(addRef);
Object.values(manifest.action?.default_icon || {}).forEach(addRef);
addRef(manifest.background?.service_worker);
for (const entry of manifest.content_scripts || []) {
  (entry.js || []).forEach(addRef);
  (entry.css || []).forEach(addRef);
}
(manifest.web_accessible_resources || []).forEach((resource) => {
  (resource.resources || []).forEach(addRef);
});

for (const reference of referenced) {
  const target = path.join(EXT, reference);
  if (!fs.existsSync(target)) fail(`manifest references a missing file: ${reference}`);
}
notes.push(`manifest references ${referenced.size} file(s), all present`);

/* ──────────────────────────── content scripts ──────────────────────────── */

for (const entry of manifest.content_scripts || []) {
  const js = entry.js || [];
  const bridgeIndex = js.findIndex((file) => file.includes('bridge.js'));
  const adaptersIndex = js.findIndex((file) => file.includes('site-adapters.js'));
  if (bridgeIndex >= 0 && adaptersIndex >= 0 && adaptersIndex > bridgeIndex) {
    fail('site-adapters.js must be listed before bridge.js in content_scripts.js');
  }

  const hosts = (entry.matches || []).map((pattern) => {
    try {
      return new URL(pattern.replace('*', '')).hostname;
    } catch {
      return null;
    }
  });
  const permissions = manifest.host_permissions || [];
  for (const host of hosts.filter(Boolean)) {
    const covered = permissions.some((permission) => {
      try {
        const allowed = new URL(permission.replace('*', '')).hostname;
        return host === allowed || host.endsWith(`.${allowed}`);
      } catch {
        return false;
      }
    });
    if (!covered) fail(`content script host ${host} is not covered by host_permissions`);
  }
}

/* ──────────────────────────────── scripts ──────────────────────────────── */

const jsFiles = walk(EXT).filter((file) => file.endsWith('.js'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multichatai-check-'));
let checked = 0;

for (const file of jsFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const copy = path.join(tmp, `${path.basename(file, '.js')}-${checked}.mjs`);
  fs.writeFileSync(copy, source);
  try {
    execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' });
    checked += 1;
  } catch (error) {
    const detail = String(error.stderr || error.message).split('\n').slice(0, 4).join('\n');
    fail(`syntax error in ${rel(file)}:\n${detail}`);
  }

  if (/\beval\s*\(/.test(source) || /new\s+Function\s*\(/.test(source)) {
    fail(`${rel(file)} uses eval/new Function, which MV3 forbids`);
  }

  // Relative imports in ES modules must resolve to real files.
  const importRe = /(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+['"](\.[^'"]+)['"]/g;
  let match;
  while ((match = importRe.exec(source))) {
    const target = path.resolve(path.dirname(file), match[1]);
    if (!fs.existsSync(target)) fail(`${rel(file)} imports a missing file: ${match[1]}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
notes.push(`${checked}/${jsFiles.length} JS file(s) parse cleanly`);

/* ───────────────────────────────── HTML ───────────────────────────────── */

const htmlFiles = walk(EXT).filter((file) => file.endsWith('.html'));
for (const file of htmlFiles) {
  const html = fs.readFileSync(file, 'utf8');
  if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html)) {
    fail(`${rel(file)} contains an inline <script> (blocked by the MV3 CSP)`);
  }
  if (/\son[a-z]+\s*=\s*["']/i.test(html)) {
    fail(`${rel(file)} uses inline event handlers, which the MV3 CSP blocks`);
  }

  const symbols = new Set([...html.matchAll(/<symbol[^>]*id="([^"]+)"/g)].map((m) => m[1]));
  const uses = new Set([...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]));
  for (const use of uses) {
    if (!symbols.has(use)) fail(`${rel(file)} references icon #${use} with no <symbol id="${use}">`);
  }

  for (const script of [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1])) {
    if (!fs.existsSync(path.join(path.dirname(file), script))) {
      fail(`${rel(file)} loads a missing script: ${script}`);
    }
  }
  for (const href of [...html.matchAll(/<link[^>]*href="([^"]+)"/g)].map((m) => m[1])) {
    if (!fs.existsSync(path.join(path.dirname(file), href))) {
      fail(`${rel(file)} links a missing stylesheet: ${href}`);
    }
  }
}
notes.push(`${htmlFiles.length} HTML file(s) checked for CSP-safe markup`);

/* Icons referenced from JS templates (#i-*) also need symbols. */
const appHtml = fs.readFileSync(path.join(EXT, 'src', 'app', 'app.html'), 'utf8');
const symbolIds = new Set([...appHtml.matchAll(/<symbol[^>]*id="([^"]+)"/g)].map((m) => m[1]));
for (const file of jsFiles.filter((candidate) => candidate.includes(`${path.sep}app${path.sep}`))) {
  const source = fs.readFileSync(file, 'utf8');
  for (const icon of new Set([...source.matchAll(/href="#(i-[a-z-]+)"/g)].map((m) => m[1]))) {
    if (!symbolIds.has(icon)) fail(`${rel(file)} uses icon #${icon} that app.html does not define`);
  }
}

/* ──────────────────────────────── report ──────────────────────────────── */

console.log(`MultiChatAI — v${manifest.version}, manifest v${manifest.manifest_version}`);
for (const note of notes) console.log(`  · ${note}`);

if (problems.length) {
  console.error(`\n✗ ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log('\n✓ all static checks passed');
