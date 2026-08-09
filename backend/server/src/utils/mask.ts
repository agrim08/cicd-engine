import { db } from '../storage/db';
import { decrypt } from './crypto';

// In-memory cache for decrypted repository secrets to avoid DB lookups on every log request
interface CachedSecrets {
  values: string[];
  expiresAt: number;
}

const secretsCache = new Map<string, CachedSecrets>();
const CACHE_TTL_MS = 60 * 1000; // 1 minute TTL

/**
 * Scan log content and mask any occurrences of decrypted repository secrets.
 * Uses an in-memory cache with a 1-minute TTL to optimize performance.
 */
export async function maskSecrets(content: string, repoId: string): Promise<string> {
  const now = Date.now();
  const cached = secretsCache.get(repoId);

  let secretValues: string[] = [];

  if (cached && cached.expiresAt > now) {
    secretValues = cached.values;
  } else {
    try {
      const secrets = await db('secrets').where({ repo_id: repoId });
      secretValues = secrets
        .map((s) => {
          try {
            return decrypt(s.encrypted_value, s.iv);
          } catch {
            return '';
          }
        })
        .filter((val) => val.length >= 4); // Skip very short values to prevent over-masking (e.g. "a", "123")

      secretsCache.set(repoId, {
        values: secretValues,
        expiresAt: now + CACHE_TTL_MS,
      });
    } catch (error) {
      console.error(`❌ [Secrets Masking] Failed to fetch/decrypt secrets for repo ${repoId}:`, error);
      return content;
    }
  }

  if (secretValues.length === 0) {
    return content;
  }

  let masked = content;
  for (const value of secretValues) {
    masked = masked.replaceAll(value, '***');
  }

  return masked;
}
