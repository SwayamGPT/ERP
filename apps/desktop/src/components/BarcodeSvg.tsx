import { ean13Modules, isValidEan13 } from '@hisaab/core';

/** EAN-13 rendered as crisp SVG bars with human-readable digits. */
export function BarcodeSvg({ code, height = 40, module = 1.4 }: { code: string; height?: number; module?: number }) {
  if (!isValidEan13(code)) return <div className="text-[9px] text-bad">Invalid barcode</div>;
  const bits = ean13Modules(code);
  const width = (bits.length + 18) * module;
  const bars: Array<{ x: number; w: number; guard: boolean }> = [];
  let i = 0;
  while (i < bits.length) {
    if (bits[i] === '1') {
      let j = i;
      while (bits[j] === '1') j++;
      const guard = i < 3 || (i >= 45 && i < 50) || i >= 92;
      bars.push({ x: (i + 9) * module, w: (j - i) * module, guard });
      i = j;
    } else i++;
  }
  const fs = 7.5 * module;
  return (
    <svg width={width} height={height + fs} viewBox={`0 0 ${width} ${height + fs}`} role="img" aria-label={`Barcode ${code}`}>
      <rect width={width} height={height + fs} fill="#fff" />
      {bars.map((b, k) => (
        <rect key={k} x={b.x} y={0} width={b.w} height={b.guard ? height + fs / 2 : height} fill="#000" />
      ))}
      <text x={2 * module} y={height + fs} fontSize={fs} fontFamily="monospace">{code[0]}</text>
      <text x={(9 + 3 + 21) * module} y={height + fs} fontSize={fs} fontFamily="monospace" textAnchor="middle">{code.slice(1, 7)}</text>
      <text x={(9 + 50 + 21) * module} y={height + fs} fontSize={fs} fontFamily="monospace" textAnchor="middle">{code.slice(7)}</text>
    </svg>
  );
}
