// After `tauri android init`: let the app talk plain HTTP to the shop computer on the local
// Wi-Fi (e.g. http://192.168.1.5:8787). Android blocks clear-text HTTP in release builds unless
// the app says otherwise, and shop computers have no HTTPS certificate.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const main = join(dirname(fileURLToPath(import.meta.url)), '..', 'gen', 'android', 'app', 'src', 'main');
const manifest = join(main, 'AndroidManifest.xml');
if (!existsSync(manifest)) throw new Error(`Not found: ${manifest} (run "tauri android init" first)`);

let xml = readFileSync(manifest, 'utf8');
xml = xml.replace(/android:usesCleartextTraffic="[^"]*"/, 'android:usesCleartextTraffic="true"');
if (!/usesCleartextTraffic/.test(xml)) xml = xml.replace('<application', '<application android:usesCleartextTraffic="true"');
if (!/networkSecurityConfig/.test(xml)) xml = xml.replace('<application', '<application android:networkSecurityConfig="@xml/network_security_config"');
if (!/ACCESS_NETWORK_STATE/.test(xml)) xml = xml.replace('<application', '<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />\n    <application');
if (!/android.permission.INTERNET/.test(xml)) xml = xml.replace('<application', '<uses-permission android:name="android.permission.INTERNET" />\n    <application');
writeFileSync(manifest, xml);

const res = join(main, 'res', 'xml');
mkdirSync(res, { recursive: true });
writeFileSync(
  join(res, 'network_security_config.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<!-- Plain HTTP is only used to reach the shop computer on the local Wi-Fi; everything on the internet stays HTTPS (enforced by the app's content policy). -->
<network-security-config>
  <base-config cleartextTrafficPermitted="true" />
</network-security-config>
`,
);
console.log('Android manifest patched for the shop Wi-Fi.');
