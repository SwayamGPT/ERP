import { describe, expect, it } from 'vitest';
import { acceptPairLink, appIntentUrl, lanConfig, parsePairLink, pendingPairCode, watchAppLinks } from '../src/lan/client';

describe('pairing a phone from the QR code', () => {
  it('reads the app link and the web link the QR holds', () => {
    expect(parsePairLink('hisaab://pair?host=192.168.1.5:8787&code=123456')).toEqual({ base: 'http://192.168.1.5:8787', code: '123456' });
    expect(parsePairLink('http://192.168.1.5:8787/#pair=654321')).toEqual({ base: 'http://192.168.1.5:8787', code: '654321' });
    expect(parsePairLink('hisaab://pair?host=evil.com/x&code=123456')).toBeNull();
    expect(parsePairLink('hisaab://pair?host=192.168.1.5&code=12')).toBeNull();
    expect(parsePairLink('javascript:alert(1)#pair=123456')).toBeNull();
  });

  it('a phone browser hands over to the app, and comes back to the browser if it is not installed', () => {
    const intent = appIntentUrl('http://192.168.1.5:8787/#pair=123456')!;
    expect(intent).toMatch(/^intent:\/\/pair\?host=192\.168\.1\.5%3A8787&code=123456#Intent;scheme=hisaab;/);
    const fallback = decodeURIComponent(/S\.browser_fallback_url=([^;]+)/.exec(intent)![1]);
    expect(fallback).toBe('http://192.168.1.5:8787/?web=1#pair=123456');
    expect(intent.endsWith(';end')).toBe(true);
  });

  it('the app opened by a link knows the computer and the code', () => {
    const w = globalThis as unknown as { window?: unknown; HisaabAndroid?: unknown; addEventListener?: unknown };
    const listeners: Array<(e: Event) => void> = [];
    (globalThis as unknown as { window: unknown }).window = { HisaabAndroid: { takeLink: () => 'hisaab://pair?host=10.0.0.7:8787&code=111222' }, addEventListener: (_: string, f: (e: Event) => void) => listeners.push(f) };
    let seen = 0;
    watchAppLinks(() => seen++);
    expect(lanConfig().base).toBe('http://10.0.0.7:8787');
    expect(pendingPairCode()).toBe('111222');
    expect(lanConfig().device).toBeNull();
    // Another code scanned while the app is open
    listeners[0]({ detail: 'hisaab://pair?host=10.0.0.8:8787&code=333444' } as unknown as Event);
    expect(lanConfig().base).toBe('http://10.0.0.8:8787');
    expect(pendingPairCode()).toBe('333444');
    expect(seen).toBe(2);
    expect(acceptPairLink('not a link')).toBe(false);
    delete (globalThis as unknown as { window?: unknown }).window;
    void w;
  });
});
