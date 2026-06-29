import { parseAppRangeEnd, parseAppRangeStart } from './time.js';

export function isSet(value) {
  return value !== undefined && value !== null && value !== '' && value !== 'ALL';
}

export function applyDateRange(filter, query, field = 'createdAt') {
  if (!query?.from && !query?.to) return filter;
  filter[field] = filter[field] || {};
  if (query.from) filter[field].$gte = parseAppRangeStart(query.from);
  if (query.to) filter[field].$lte = parseAppRangeEnd(query.to);
  return filter;
}
