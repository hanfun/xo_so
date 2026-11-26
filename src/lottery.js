// Node adapter: retain the configurable local sources.
import { API_BASE, FALLBACK_API_BASE } from './config.js';
import { fetchDay as fetchPortableDay } from './lottery-core.js';
export * from './lottery-core.js';
export function fetchDay(day, options = {}) {
  return fetchPortableDay(day, { baseUrl: API_BASE, fallbackBaseUrl: FALLBACK_API_BASE, ...options });
}
