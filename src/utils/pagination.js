function safePositiveInt(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(Math.floor(number), 1);
}

export function parsePagination(query = {}, options = {}) {
  const defaultLimit = options.defaultLimit || 20;
  const maxLimit = options.maxLimit || 100;
  const page = safePositiveInt(query.page, 1);
  const requestedLimit = safePositiveInt(query.limit, defaultLimit);
  const limit = Math.min(requestedLimit, maxLimit);
  return { page, limit, skip: (page - 1) * limit };
}
