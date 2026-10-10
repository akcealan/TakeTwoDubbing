// Best-effort per-isolate HTTP protection; not a distributed production quota.
const buckets = new Map<string, { count: number; resetAt: number }>()
export function allowRequest(key: string, limit: number, now = Date.now()): boolean {
  if (buckets.size > 5000) {
    for (const [entry, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(entry)
    if (buckets.size > 5000) return false
  }
  let bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + 60_000 }
    buckets.set(key, bucket)
  }
  return ++bucket.count <= limit
}
