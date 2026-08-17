// Vendors the source-only bundled plugins (bundled-plugins/<name>) into both
// node_modules trees as REAL directories, so the packaged app never ships
// npm file:-dependency junctions whose absolute dev-machine targets would
// dangle on end-user machines (electron-builder preserves junctions verbatim).
//
// Idempotent: runs after every `npm install` (postinstall) and before every
// build (predist). A pre-existing junction is removed without following it
// (verified: fs.rmSync on a junction whose lstat is a symlink deletes the
// link only, never the target).
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const VENDORED = ['dsh-at-file', 'dsh-goal-mode'];
const TARGETS = ['node_modules', path.join('app-deps', 'node_modules')];

function copyDir(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, {
    recursive: true,
    force: true,
    filter: (p) => {
      const rel = path.relative(src, p);
      if (rel === '') return true;
      const seg = rel.split(path.sep);
      return !seg.includes('node_modules') && !seg.includes('.git');
    },
  });
}

let replaced = 0;
for (const name of VENDORED) {
  const src = path.join(repoRoot, 'bundled-plugins', name);
  if (!fs.existsSync(path.join(src, 'package.json'))) {
    console.log(`[vendor-bundled-plugins] missing source bundled-plugins/${name} — skipping`);
    continue;
  }
  for (const base of TARGETS) {
    const dst = path.join(repoRoot, base, name);
    try {
      if (fs.existsSync(dst) && fs.lstatSync(dst).isSymbolicLink()) {
        fs.rmSync(dst, { force: true }); // removes the link only
      }
      if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
      copyDir(src, dst);
      replaced++;
    } catch (e) {
      console.error(`[vendor-bundled-plugins] failed to vendor ${name} into ${base}: ${e && e.message ? e.message : e}`);
    }
  }
}

console.log(replaced === 0 ? '[vendor-bundled-plugins] nothing to vendor' : `[vendor-bundled-plugins] vendored ${replaced} dir(s)`);
