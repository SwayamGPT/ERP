/** Compare dotted versions ("0.1.312" vs "0.1.40"): negative if a is older, 0 if equal, positive if newer. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The version in a release title like "Hisaab 0.1.312 — latest build". */
export const versionInTitle = (title: string | null | undefined) => /\b(\d+\.\d+\.\d+)\b/.exec(title ?? '')?.[1] ?? null;
