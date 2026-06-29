const LEAD_SEARCH_FIELDS = [
  'name',
  'businessName',
  'phone',
  'callPhone',
  'whatsappPhone',
  'place',
  'campaignName',
  'formName',
  'metaLeadId',
];

export function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenMatchClause(token) {
  const trimmed = String(token || '').trim();
  if (!trimmed) return null;

  const or = LEAD_SEARCH_FIELDS.map((field) => ({
    [field]: { $regex: escapeRegex(trimmed), $options: 'i' },
  }));

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length >= 2) {
    const digitPattern = digits.split('').map((d) => escapeRegex(d)).join('\\D*');
    for (const field of ['phone', 'callPhone', 'whatsappPhone']) {
      or.push({ [field]: { $regex: digitPattern, $options: 'i' } });
    }
  }

  if (trimmed.length >= 3) {
    const fuzzyPattern = trimmed.split('').map((char) => escapeRegex(char)).join('.{0,2}?');
    for (const field of ['name', 'businessName', 'place']) {
      or.push({ [field]: { $regex: fuzzyPattern, $options: 'i' } });
    }
  }

  return { $or: or };
}

export function buildLeadSearchFilter(query) {
  const raw = String(query || '').trim();
  if (!raw) return null;

  const tokens = raw.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;

  const clauses = tokens.map(tokenMatchClause).filter(Boolean);
  if (!clauses.length) return null;
  if (clauses.length === 1) return clauses[0];
  return { $and: clauses };
}

export function applyLeadSearchFilter(filter, query) {
  const search = buildLeadSearchFilter(query);
  if (!search) return filter;
  if (!filter || Object.keys(filter).length === 0) return search;
  return { $and: [filter, search] };
}
