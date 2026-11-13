import type { BusinessType } from './repos/company';

export const BUSINESS_TYPES: Record<BusinessType, { label: string; hint: string; emoji: string }> = {
  kirana: { label: 'Kirana / General store', hint: 'Loose grains by weight, packed goods, udhaar for regulars', emoji: '🛒' },
  supermarket: { label: 'Supermarket / Mart', hint: 'Fast barcode billing, many categories, weighing scale', emoji: '🏬' },
  wholesaler: { label: 'Wholesaler', hint: 'Cartons & bags, wholesale rates, schemes, credit', emoji: '📦' },
  distributor: { label: 'Distributor / Stockist', hint: 'Retailer orders, beat routes, super-stockist rates', emoji: '🚚' },
  restaurant: { label: 'Restaurant / Sweet shop / Bakery', hint: 'Counter bills, quick items, made-to-order goods', emoji: '🍽️' },
  other: { label: 'Other food business', hint: 'Dairy, fruits & vegetables, dry fruits, spices…', emoji: '🏪' },
};
