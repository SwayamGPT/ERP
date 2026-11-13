export type Template = 'kirana' | 'supermarket' | 'wholesaler';

export const TEMPLATES: Record<Template, { label: string; hint: string; emoji: string }> = {
  kirana: { label: 'Kirana / General Store', hint: 'Loose grains by weight, packed goods, udhaar for regulars', emoji: '🛒' },
  supermarket: { label: 'Supermarket', hint: 'Fast barcode billing, many categories, weighing scale', emoji: '🏬' },
  wholesaler: { label: 'Wholesaler / Distributor', hint: 'Cartons & boxes, wholesale rates, schemes, credit', emoji: '🚚' },
};
