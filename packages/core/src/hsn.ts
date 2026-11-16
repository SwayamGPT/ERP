export interface HsnEntry {
  code: string;
  description: string;
  rate: number;
  uqc: string;
  /** Compensation cess %, where a flat percentage applies (confirm with your CA). */
  cess?: number;
}

/**
 * Common HSN codes for grocery, FMCG and general trade with typical GST rates after the
 * GST 2.0 rationalisation (22 Sep 2025). Rates can depend on packaging and labelling —
 * always confirm with your CA. Users can override the rate per item.
 */
export const HSN_CATALOG: HsnEntry[] = [
  { code: '0401', description: 'Milk, fresh / UHT (not concentrated)', rate: 0, uqc: 'LTR' },
  { code: '0402', description: 'Milk powder, condensed milk', rate: 5, uqc: 'KGS' },
  { code: '0403', description: 'Curd, lassi, buttermilk (packed)', rate: 5, uqc: 'KGS' },
  { code: '0405', description: 'Butter, ghee, dairy spreads', rate: 5, uqc: 'KGS' },
  { code: '0406', description: 'Cheese', rate: 5, uqc: 'KGS' },
  { code: '04061000', description: 'Paneer / chena (pre-packaged)', rate: 0, uqc: 'KGS' },
  { code: '0407', description: 'Eggs, fresh', rate: 0, uqc: 'NOS' },
  { code: '0409', description: 'Honey, natural', rate: 5, uqc: 'KGS' },
  { code: '0701', description: 'Potatoes, fresh', rate: 0, uqc: 'KGS' },
  { code: '0703', description: 'Onions, garlic, fresh', rate: 0, uqc: 'KGS' },
  { code: '0709', description: 'Other vegetables, fresh', rate: 0, uqc: 'KGS' },
  { code: '0713', description: 'Pulses / dal, dried (pre-packaged, labelled)', rate: 5, uqc: 'KGS' },
  { code: '0801', description: 'Coconuts, cashew nuts', rate: 5, uqc: 'KGS' },
  { code: '0802', description: 'Almonds, walnuts, pistachios (dry fruits)', rate: 5, uqc: 'KGS' },
  { code: '0803', description: 'Bananas, fresh', rate: 0, uqc: 'KGS' },
  { code: '0806', description: 'Grapes fresh / raisins dried', rate: 5, uqc: 'KGS' },
  { code: '0901', description: 'Coffee beans / roasted coffee', rate: 5, uqc: 'KGS' },
  { code: '0902', description: 'Tea', rate: 5, uqc: 'KGS' },
  { code: '0904', description: 'Pepper, chilli (spices)', rate: 5, uqc: 'KGS' },
  { code: '0909', description: 'Cumin, coriander, fennel seeds', rate: 5, uqc: 'KGS' },
  { code: '0910', description: 'Turmeric, ginger, mixed spices', rate: 5, uqc: 'KGS' },
  { code: '1001', description: 'Wheat (pre-packaged, labelled)', rate: 5, uqc: 'KGS' },
  { code: '1006', description: 'Rice (pre-packaged, labelled)', rate: 5, uqc: 'KGS' },
  { code: '1101', description: 'Wheat flour / atta (pre-packaged)', rate: 5, uqc: 'KGS' },
  { code: '1102', description: 'Besan, maida, other flours', rate: 5, uqc: 'KGS' },
  { code: '1104', description: 'Poha, oats, rolled grains', rate: 5, uqc: 'KGS' },
  { code: '1507', description: 'Soyabean oil', rate: 5, uqc: 'LTR' },
  { code: '1508', description: 'Groundnut oil', rate: 5, uqc: 'LTR' },
  { code: '1512', description: 'Sunflower oil', rate: 5, uqc: 'LTR' },
  { code: '1514', description: 'Mustard / rapeseed oil', rate: 5, uqc: 'LTR' },
  { code: '1516', description: 'Vanaspati, hydrogenated oils', rate: 5, uqc: 'KGS' },
  { code: '1701', description: 'Sugar', rate: 5, uqc: 'KGS' },
  { code: '1702', description: 'Jaggery (pre-packaged), glucose', rate: 5, uqc: 'KGS' },
  { code: '1704', description: 'Sugar confectionery, toffees', rate: 5, uqc: 'KGS' },
  { code: '1806', description: 'Chocolates, cocoa preparations', rate: 5, uqc: 'KGS' },
  { code: '1901', description: 'Malt drinks, health drink powders', rate: 5, uqc: 'KGS' },
  { code: '1902', description: 'Pasta, noodles, vermicelli', rate: 5, uqc: 'KGS' },
  { code: '1904', description: 'Cornflakes, muesli, puffed cereals', rate: 5, uqc: 'KGS' },
  { code: '1905', description: 'Biscuits, cakes, rusk, pastries', rate: 5, uqc: 'KGS' },
  { code: '19059020', description: 'Bread, pizza bread, khakhra, roti (plain)', rate: 0, uqc: 'NOS' },
  { code: '2001', description: 'Pickles, achaar', rate: 5, uqc: 'KGS' },
  { code: '2007', description: 'Jams, jellies, marmalade', rate: 5, uqc: 'KGS' },
  { code: '2009', description: 'Fruit juices (non-aerated)', rate: 5, uqc: 'LTR' },
  { code: '2101', description: 'Instant coffee, tea extracts', rate: 5, uqc: 'KGS' },
  { code: '2103', description: 'Sauces, ketchup, mixed condiments', rate: 5, uqc: 'KGS' },
  { code: '2104', description: 'Soups and broths', rate: 5, uqc: 'KGS' },
  { code: '2105', description: 'Ice cream, frozen desserts', rate: 5, uqc: 'KGS' },
  { code: '2106', description: 'Namkeen, bhujia, ready-to-eat snacks', rate: 5, uqc: 'KGS' },
  { code: '21069020', description: 'Pan masala (plus compensation cess)', rate: 28, uqc: 'KGS', cess: 60 },
  { code: '2201', description: 'Packaged drinking water', rate: 5, uqc: 'LTR' },
  { code: '2202', description: 'Aerated / carbonated beverages, colas', rate: 40, uqc: 'LTR' },
  { code: '22029920', description: 'Plant-based milk drinks', rate: 5, uqc: 'LTR' },
  { code: '2501', description: 'Salt', rate: 0, uqc: 'KGS' },
  { code: '3304', description: 'Cosmetics, creams, make-up', rate: 18, uqc: 'NOS' },
  { code: '3305', description: 'Hair oil, shampoo', rate: 5, uqc: 'NOS' },
  { code: '3306', description: 'Toothpaste, tooth powder', rate: 5, uqc: 'NOS' },
  { code: '3307', description: 'Shaving cream, deodorants, agarbatti', rate: 18, uqc: 'NOS' },
  { code: '3401', description: 'Toilet soap, bathing bars', rate: 5, uqc: 'NOS' },
  { code: '3402', description: 'Detergent powder, liquid, dishwash', rate: 18, uqc: 'KGS' },
  { code: '3808', description: 'Mosquito repellents, insecticides', rate: 18, uqc: 'NOS' },
  { code: '4818', description: 'Toilet paper, tissues, napkins', rate: 5, uqc: 'NOS' },
  { code: '8506', description: 'Batteries (primary cells)', rate: 18, uqc: 'NOS' },
  { code: '8539', description: 'LED lamps, bulbs', rate: 18, uqc: 'NOS' },
  { code: '9603', description: 'Toothbrushes, brooms, brushes', rate: 5, uqc: 'NOS' },
  { code: '9619', description: 'Sanitary napkins', rate: 0, uqc: 'NOS' },
  { code: '96190030', description: 'Baby diapers', rate: 5, uqc: 'NOS' },
  { code: '2402', description: 'Cigarettes, bidis, tobacco (cess per stick varies: enter it on the item)', rate: 40, uqc: 'NOS' },
];

export function searchHsn(q: string, limit = 12): HsnEntry[] {
  const s = q.trim().toLowerCase();
  if (!s) return HSN_CATALOG.slice(0, limit);
  const words = s.split(/\s+/);
  return HSN_CATALOG.map((h) => {
    const hay = `${h.code} ${h.description}`.toLowerCase();
    let score = 0;
    if (h.code.startsWith(s)) score += 10;
    for (const w of words) if (hay.includes(w)) score += 2;
    return { h, score };
  })
    .filter((x) => x.score >= words.length * 2 || x.score >= 10)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.h);
}

/**
 * The usual GST rate for an HSN code: the catalogue entry that matches it most closely (an
 * 8-digit code falls back to its 6- or 4-digit heading). Null when the code isn't known.
 */
export function gstRateForHsn(code: string | null | undefined): number | null {
  const c = (code ?? '').replace(/\D/g, '');
  if (c.length < 4) return null;
  let best: HsnEntry | null = null;
  for (const h of HSN_CATALOG) {
    if (c.startsWith(h.code) && (!best || h.code.length > best.code.length)) best = h;
  }
  return best ? best.rate : null;
}

/** The compensation cess % usually charged for an HSN code (0 when none is listed). */
export function cessForHsn(code: string | null | undefined): number {
  const c = (code ?? '').replace(/\D/g, '');
  if (c.length < 4) return 0;
  let best: HsnEntry | null = null;
  for (const h of HSN_CATALOG) if (c.startsWith(h.code) && (!best || h.code.length > best.code.length)) best = h;
  return best?.cess ?? 0;
}

/** Map our unit names to GSTN UQC codes. */
export function uqcFor(unit: string): string {
  const u = unit.trim().toLowerCase();
  const map: Record<string, string> = {
    pcs: 'NOS', pc: 'NOS', nos: 'NOS', piece: 'NOS', pkt: 'PAC', packet: 'PAC', pack: 'PAC',
    kg: 'KGS', kgs: 'KGS', g: 'GMS', gm: 'GMS', gms: 'GMS', gram: 'GMS', quintal: 'QTL', qtl: 'QTL',
    l: 'LTR', ltr: 'LTR', litre: 'LTR', liter: 'LTR', ml: 'MLT',
    box: 'BOX', carton: 'CTN', ctn: 'CTN', bag: 'BAG', dozen: 'DOZ', doz: 'DOZ', bottle: 'BTL', btl: 'BTL',
    strip: 'NOS', tin: 'TIN', jar: 'NOS', bundle: 'BDL', roll: 'ROL', set: 'SET', pair: 'PRS',
  };
  return map[u] ?? 'OTH';
}
