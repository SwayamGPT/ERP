import { describe, expect, it } from 'vitest';
import { compareVersions, versionInTitle } from '../src/lib/version';

describe('app versions', () => {
  it('compare numerically, not as text', () => {
    expect(compareVersions('0.1.312', '0.1.40')).toBeGreaterThan(0);
    expect(compareVersions('0.1.40', '0.1.312')).toBeLessThan(0);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0', '0.9.99')).toBeGreaterThan(0);
  });
  it('read the version from the release title', () => {
    expect(versionInTitle('Hisaab 0.1.312 — latest build')).toBe('0.1.312');
    expect(versionInTitle('Hisaab  — latest build')).toBeNull();
  });
});
