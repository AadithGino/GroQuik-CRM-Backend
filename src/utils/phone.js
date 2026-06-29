export function normalizePhone(value) {
  if (!value) return '';
  const raw = String(value).trim();
  let digits = raw.replace(/[^0-9]/g, '');
  if (digits.length > 10 && digits.startsWith('91')) digits = digits.slice(-10);
  if (digits.length > 10) digits = digits.slice(-10);
  return digits;
}

export function isValidIndianMobile(value) {
  const phone = normalizePhone(value);
  return /^[6-9]\d{9}$/.test(phone);
}

export function toWhatsAppPhone(value) {
  const phone = normalizePhone(value);
  if (!phone) return '';
  return phone.length === 10 ? `91${phone}` : phone;
}
