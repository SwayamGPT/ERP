// After `tauri android init`: let the app talk plain HTTP to the shop computer on the local
// Wi-Fi (e.g. http://192.168.1.5:8787). Android blocks clear-text HTTP in release builds unless
// the app says otherwise, and shop computers have no HTTPS certificate.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

// The app draws edge to edge on new Android versions, so its page slid under the status bar,
// camera cut-out and navigation bar. Pad the app's view by those bars (and the keyboard).
const find = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      const r = find(p);
      if (r) return r;
    } else if (f === 'MainActivity.kt') return p;
  }
  return null;
};
const activity = find(join(main, 'java'));
if (!activity) throw new Error('MainActivity.kt not found');
const old = readFileSync(activity, 'utf8');
const pkg = /^package .*$/m.exec(old)?.[0];
if (!pkg) throw new Error('No package line in MainActivity.kt');
const edge = old.includes('enableEdgeToEdge');
writeFileSync(
  activity,
  `${pkg}

import android.content.Context
import android.os.Bundle
import android.print.PrintAttributes
import android.print.PrintManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
${edge ? 'import androidx.activity.enableEdgeToEdge\n' : ''}import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
${edge ? '    enableEdgeToEdge()\n' : ''}    super.onCreate(savedInstanceState)
    // Keep Hisaab clear of the status bar, camera cut-out, navigation bar and the keyboard.
    val root = findViewById<android.view.View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      )
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }

  // window.print() does nothing in an Android web view: hand the page (its print layout) to
  // Android's printing, which offers "Save as PDF" and any printer the phone knows.
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.addJavascriptInterface(PrintBridge(this, webView), "HisaabAndroid")
  }

  class PrintBridge(private val activity: MainActivity, private val webView: WebView) {
    @JavascriptInterface
    fun print(title: String) {
      activity.runOnUiThread {
        val pm = activity.getSystemService(Context.PRINT_SERVICE) as PrintManager
        pm.print(title, webView.createPrintDocumentAdapter(title), PrintAttributes.Builder().build())
      }
    }
  }
}
`,
);
console.log('MainActivity: content kept clear of system bars.');
