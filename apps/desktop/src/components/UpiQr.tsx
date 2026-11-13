import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

export function UpiQr({ link, size = 180, className }: { link: string; size?: number; className?: string }) {
  const [src, setSrc] = useState<string>('');
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(link, { margin: 1, width: size * 2, errorCorrectionLevel: 'M' }).then((s) => live && setSrc(s));
    return () => {
      live = false;
    };
  }, [link, size]);
  return src ? <img src={src} width={size} height={size} alt="UPI QR code" className={className} data-testid="upi-qr" /> : <div style={{ width: size, height: size }} />;
}
