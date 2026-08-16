// Applies committed client-plugin patches over freshly installed node_modules.
// Dependency-free so it can run inside `npm install` postinstall hooks without
// pulling extra packages. Idempotent: skips files whose bytes already match.
//
// Patches live under <repo>/patches/. Each entry maps a patch file basename to
// the (possibly multiple) on-disk locations the same package can be installed at.
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const patchesDir = path.join(repoRoot, 'patches');

const PATCHES = [
  {
    patch: 'dsh-client-ui-conversation.client.js',
    note: 'long-text -> collapsible .txt card (LONG_TEXT_CHARS threshold)',
    targets: [
      'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js',
      'app-deps/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js'
    ]
  }
];

let applied = 0;
for (const p of PATCHES) {
  const src = path.join(patchesDir, p.patch);
  if (!fs.existsSync(src)) {
    console.log(`[apply-patches] missing ${p.patch} — skipping (${p.note})`);
    continue;
  }
  const content = fs.readFileSync(src);
  for (const rel of p.targets) {
    const dst = path.join(repoRoot, rel);
    if (!fs.existsSync(dst)) continue;
    const current = fs.readFileSync(dst);
    if (current.equals(content)) continue; // already applied
    fs.writeFileSync(dst, content);
    applied++;
    console.log(`[apply-patches] patched ${rel}`);
  }
}

console.log(applied === 0 ? '[apply-patches] nothing to patch' : `[apply-patches] ${applied} file(s) patched`);
