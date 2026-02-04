import { jwtVerify, createRemoteJWKSet, type JWTPayload as JoseJWTPayload, type KeyLike } from 'jose';
import type { JWTPayload } from '../types';

/**
 * JWKS cache to avoid creating new fetchers on every request.
 * Key: issuer URL, Value: { jwks, createdAt }
 *
 * Cache entries expire after 5 minutes to pick up key rotations.
 */
const jwksCache = new Map<string, { jwks: ReturnType<typeof createRemoteJWKSet>; createdAt: number }>();
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Clear the JWKS cache (exported for testing) */
export function clearJWKSCache(): void {
  jwksCache.clear();
}

function getOrCreateJWKS(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = jwksCache.get(issuer);
  const now = Date.now();

  if (cached && (now - cached.createdAt) < JWKS_CACHE_TTL_MS) {
    return cached.jwks;
  }

  // Create new JWKS fetcher
  const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  jwksCache.set(issuer, { jwks, createdAt: now });

  return jwks;
}

/**
 * Verify a Cloudflare Access JWT token using the jose library.
 *
 * This follows Cloudflare's recommended approach:
 * https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/#cloudflare-workers-example
 *
 * @param token - The JWT token string
 * @param teamDomain - The Cloudflare Access team domain (e.g., 'myteam.cloudflareaccess.com')
 * @param expectedAud - The expected audience (Application AUD tag)
 * @returns The decoded JWT payload if valid
 * @throws Error if the token is invalid, expired, or doesn't match expected values
 */
export async function verifyAccessJWT(
  token: string,
  teamDomain: string,
  expectedAud: string
): Promise<JWTPayload> {
  // Ensure teamDomain has https:// prefix for issuer check
  const issuer = teamDomain.startsWith('https://')
    ? teamDomain
    : `https://${teamDomain}`;

  // Get cached JWKS or create new one
  const JWKS = getOrCreateJWKS(issuer);

  // Verify the JWT using jose
  const { payload } = await jwtVerify(token, JWKS, {
    issuer,
    audience: expectedAud,
  });

  // Cast to our JWTPayload type
  return payload as unknown as JWTPayload;
}
