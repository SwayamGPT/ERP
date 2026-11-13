import { validateGstin } from './gst';

/** Field validators shared by the UI (instant feedback) and the database layer (enforcement). */

export const isMobile = (v: string) => /^[6-9]\d{9}$/.test(normalizePhone(v));
/** Accepts mobiles and landlines with STD code (e.g. 02024567890). */
export const isPhone = (v: string) => isMobile(v) || /^0\d{9,11}$/.test(normalizePhone(v));
export const normalizePhone = (v: string) => v.replace(/[\s()-]/g, '').replace(/^\+?91(?=\d{10}$)/, '');

export const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v.trim());

/** FSSAI licence / registration number: 14 digits. */
export const isFssai = (v: string) => /^\d{14}$/.test(v.trim());

export const isPincode = (v: string) => /^[1-9]\d{5}$/.test(v.trim());

export const isIfsc = (v: string) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v.trim().toUpperCase());

export const isPan = (v: string) => /^[A-Z]{5}\d{4}[A-Z]$/.test(v.trim().toUpperCase());

/** The PAN is embedded in a GSTIN (characters 3–12). */
export const panFromGstin = (gstin: string) => (gstin.length >= 12 ? gstin.slice(2, 12).toUpperCase() : '');

export interface EnterpriseDetails {
  name: string;
  businessType: string;
  gstin: string;
  fssai: string;
  fssaiExpiry?: string | null;
  phone: string;
  email: string;
  address: string;
  city: string;
  pincode: string;
  stateCode: string;
  bankIfsc?: string | null;
  bankAccount?: string | null;
}

/** Returns a map of field → problem. Empty map = valid. */
export function validateEnterprise(d: Partial<EnterpriseDetails>): Partial<Record<keyof EnterpriseDetails, string>> {
  const e: Partial<Record<keyof EnterpriseDetails, string>> = {};
  if (!d.name || d.name.trim().length < 2) e.name = 'Enter the business name';
  if (!d.businessType) e.businessType = 'Pick the type of business';
  if (!d.gstin) e.gstin = 'GSTIN is required';
  else if (!validateGstin(d.gstin)) e.gstin = 'This GSTIN is not valid — check all 15 characters';
  if (!d.fssai) e.fssai = 'FSSAI licence number is required';
  else if (!isFssai(d.fssai)) e.fssai = 'FSSAI number has 14 digits';
  if (d.fssaiExpiry && !/^\d{4}-\d{2}-\d{2}$/.test(d.fssaiExpiry)) e.fssaiExpiry = 'Pick a valid date';
  if (!d.phone) e.phone = 'Contact number is required';
  else if (!isPhone(d.phone)) e.phone = 'Enter a 10-digit mobile or a landline with STD code';
  if (!d.email) e.email = 'Email is required';
  else if (!isEmail(d.email)) e.email = 'Enter a valid email address';
  if (!d.address || d.address.trim().length < 5) e.address = 'Enter the full shop address';
  if (!d.city || !d.city.trim()) e.city = 'Enter the city';
  if (!d.pincode) e.pincode = 'PIN code is required';
  else if (!isPincode(d.pincode)) e.pincode = 'PIN code has 6 digits';
  if (!d.stateCode) e.stateCode = 'Pick the state';
  if (d.bankIfsc && !isIfsc(d.bankIfsc)) e.bankIfsc = 'IFSC looks wrong (e.g. HDFC0001234)';
  if (d.bankAccount && !/^\d{9,18}$/.test(d.bankAccount)) e.bankAccount = 'Account number has 9–18 digits';
  return e;
}
