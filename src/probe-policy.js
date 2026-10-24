import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const PROBE_CACHE_TTL = 8 * 60 * 60 * 1000;
export const PROBE_INTERVAL = 4000;

export function modelFingerprint(model) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return createHash('sha256').update(JSON.stringify(canonical(model))).digest('hex');
}
export function cachedProbe(model, result, previousModel, now = Date.now()) {
  const age = now - Date.parse(result?.time);
  return result?.ok === true && age >= 0 && age < PROBE_CACHE_TTL
    && (result.catalogFingerprint || (previousModel && modelFingerprint(previousModel))) === modelFingerprint(model);
}
// A rejected gateway must not receive requests for the remainder of the catalog.
// The callback returns the final error, including a failed chat-only fallback.
export async function runProbeQueue(models, { probe, onPending, onBlocked, signal, sleep = delay, random = Math.random }) {
  const pending = models.map(model => model.id);
  onPending([...pending]);
  for (const model of models) {
    if (signal.aborted) break;
    const error = await probe(model);
    pending.shift();
    onPending([...pending]);
    if (signal.aborted) break;
    if ([401, 403, 429].includes(error?.status)) {
      await onBlocked(error);
      break;
    }
    if (pending.length) {
      try { await sleep(PROBE_INTERVAL + Math.floor(random() * 1000), undefined, { signal }); }
      catch (error) { if (!signal.aborted) throw error; break; }
    }
  }
}
