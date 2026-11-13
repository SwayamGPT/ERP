import { formatINR } from '@hisaab/core';

/** UPI deep link (NPCI spec). Amount in rupees with 2 decimals. */
export function upiLink(opts: { vpa: string; name: string; amount: number; note?: string; ref?: string }) {
  const p = new URLSearchParams({ pa: opts.vpa, pn: opts.name, am: (opts.amount / 100).toFixed(2), cu: 'INR' });
  if (opts.note) p.set('tn', opts.note);
  if (opts.ref) p.set('tr', opts.ref);
  return `upi://pay?${p.toString().replace(/\+/g, '%20')}`;
}

export function waNumber(phone?: string | null) {
  const d = (phone ?? '').replace(/\D/g, '');
  if (d.length === 10) return `91${d}`;
  return d;
}

export function whatsappLink(phone: string | null | undefined, text: string) {
  const n = waNumber(phone);
  return `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
}

export function billMessage(o: { shop: string; number: string; date: string; total: number; items: number; balance?: number; upi?: string | null }) {
  const lines = [
    `🧾 *${o.shop}*`,
    `Bill ${o.number} · ${o.date}`,
    `${o.items} item${o.items === 1 ? '' : 's'} · Total *${formatINR(o.total)}*`,
  ];
  if (o.balance && o.balance > 0) lines.push(`Pending: ${formatINR(o.balance)}`);
  if (o.upi) lines.push(`Pay via UPI: ${o.upi}`);
  lines.push('', 'Thank you for shopping with us! 🙏');
  return lines.join('\n');
}

export function reminderMessage(o: { shop: string; name: string; amount: number; upi?: string | null }) {
  return [
    `Namaste ${o.name} 🙏`,
    `This is a gentle reminder from *${o.shop}* that ${formatINR(o.amount)} is pending on your account.`,
    o.upi ? `You can pay by UPI to ${o.upi}.` : 'Please pay at your convenience.',
    'Thank you!',
  ].join('\n');
}
