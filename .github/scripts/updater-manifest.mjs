// latest.json for the desktop updater, from the signatures the Windows and macOS builds published.
//   node .github/scripts/updater-manifest.mjs <dir with .sig files> <version> <download base url> > latest.json
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, version, base] = process.argv.slice(2);
const platforms = {};
const add = (keys, file) => {
  const sig = join(dir, `${file}.sig`);
  if (!existsSync(sig)) return;
  for (const k of keys) platforms[k] = { signature: readFileSync(sig, 'utf8').trim(), url: `${base}/${file}` };
};
add(['windows-x86_64'], 'Hisaab-Setup-Windows.exe');
add(['darwin-aarch64', 'darwin-x86_64'], 'Hisaab-macOS.app.tar.gz');
if (!Object.keys(platforms).length) throw new Error('No update signatures found');
process.stdout.write(`${JSON.stringify({ version, notes: `Hisaab ${version}`, pub_date: new Date().toISOString(), platforms }, null, 2)}\n`);
