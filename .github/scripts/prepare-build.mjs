// Before a CI build: give it a version and, when signing keys are set up, turn on updates.
//
// - Version: a tag v1.2.3 builds 1.2.3; every other build is 0.1.<number of commits>, so each new
//   build is newer than the last (the desktop updater and Android both need a rising version).
// - Desktop updates (Windows / macOS) need the repository secrets TAURI_SIGNING_PRIVATE_KEY,
//   TAURI_SIGNING_PRIVATE_KEY_PASSWORD and TAURI_UPDATER_PUBKEY (see README → Auto-update).
//   With them, the build signs its installers and the app checks for updates; without them the
//   build is exactly as before, with updates switched off.
// - Android updates need a stable signing key (ANDROID_KEYSTORE_BASE64 …): an APK signed with a
//   different key cannot install over the app, so without it the app doesn't offer updates.
//
//   node .github/scripts/prepare-build.mjs desktop|android
import { execSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const target = process.argv[2] ?? 'desktop';
const conf = 'apps/desktop/src-tauri/tauri.conf.json';
const ref = process.env.GITHUB_REF ?? '';
const count = Number(execSync('git rev-list --count HEAD').toString().trim());
const version = ref.startsWith('refs/tags/v') ? ref.slice('refs/tags/v'.length) : `0.1.${count}`;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not a version: ${version}`);

const c = JSON.parse(readFileSync(conf, 'utf8'));
c.version = version;
let updates = false;
if (target === 'desktop') {
  const pubkey = (process.env.UPDATER_PUBKEY ?? '').trim();
  if (pubkey && process.env.HAS_SIGNING_KEY === 'true') {
    c.plugins.updater.pubkey = pubkey;
    c.bundle.createUpdaterArtifacts = true;
    updates = true;
  }
} else updates = process.env.SIGNED === 'true';
writeFileSync(conf, `${JSON.stringify(c, null, 2)}\n`);

const env = process.env.GITHUB_ENV;
const out = [`APP_VERSION=${version}`, `VITE_UPDATES=${updates ? '1' : '0'}`].join('\n') + '\n';
if (env) appendFileSync(env, out);
console.log(`Version ${version} · updates ${updates ? 'on' : 'off (no signing keys)'}`);
