import type { Context, Next } from 'hono';
import type { AppEnv, MoltbotEnv } from '../types';
import { verifyAccessJWT } from './jwt';

/**
 * Options for creating an access middleware
 */
export interface AccessMiddlewareOptions {
  /** Response type: 'json' for API routes, 'html' for UI routes */
  type: 'json' | 'html';
  /** Whether to redirect to login when JWT is missing (only for 'html' type) */
  redirectOnMissing?: boolean;
}

/**
 * Check if running in development mode (skips CF Access auth + device pairing)
 *
 * SECURITY: DEV_MODE is blocked if CF Access is configured, preventing
 * accidental deployment to production with auth bypassed.
 */
export function isDevMode(env: MoltbotEnv): boolean {
  if (env.DEV_MODE === 'true') {
    // Block DEV_MODE if CF Access is configured (indicates production)
    if (env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD) {
      console.error('SECURITY: DEV_MODE blocked - CF Access is configured. Remove DEV_MODE for production.');
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Check if running in E2E test mode (skips CF Access auth but keeps device pairing)
 *
 * SECURITY: E2E_TEST_MODE is blocked if CF Access is configured, preventing
 * accidental deployment to production with auth bypassed.
 */
export function isE2ETestMode(env: MoltbotEnv): boolean {
  if (env.E2E_TEST_MODE === 'true') {
    // Block E2E_TEST_MODE if CF Access is configured (indicates production)
    if (env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD) {
      console.error('SECURITY: E2E_TEST_MODE blocked - CF Access is configured. Remove E2E_TEST_MODE for production.');
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Extract JWT from request headers or cookies
 */
export function extractJWT(c: Context<AppEnv>): string | null {
  const jwtHeader = c.req.header('CF-Access-JWT-Assertion');
  const jwtCookie = c.req.raw.headers.get('Cookie')
    ?.split(';')
    .find(cookie => cookie.trim().startsWith('CF_Authorization='))
    ?.split('=')[1];

  return jwtHeader || jwtCookie || null;
}

/**
 * Create a Cloudflare Access authentication middleware
 * 
 * @param options - Middleware options
 * @returns Hono middleware function
 */
export function createAccessMiddleware(options: AccessMiddlewareOptions) {
  const { type, redirectOnMissing = false } = options;

  return async (c: Context<AppEnv>, next: Next) => {
    // Skip auth in dev mode or E2E test mode
    if (isDevMode(c.env) || isE2ETestMode(c.env)) {
      c.set('accessUser', { email: 'dev@localhost', name: 'Dev User' });
      return next();
    }

    const teamDomain = c.env.CF_ACCESS_TEAM_DOMAIN;
    const expectedAud = c.env.CF_ACCESS_AUD;

    // Check if CF Access is configured
    if (!teamDomain || !expectedAud) {
      if (type === 'json') {
        return c.json({
          error: 'Cloudflare Access not configured',
          hint: 'Set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD environment variables',
        }, 500);
      } else {
        return c.html(`
          <html>
            <body>
              <h1>Admin UI Not Configured</h1>
              <p>Set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD environment variables.</p>
            </body>
          </html>
        `, 500);
      }
    }

    // Get JWT
    const jwt = extractJWT(c);

    if (!jwt) {
      if (type === 'html' && redirectOnMissing) {
        return c.redirect(`https://${teamDomain}`, 302);
      }
      
      if (type === 'json') {
        return c.json({
          error: 'Unauthorized',
          hint: 'Missing Cloudflare Access JWT. Ensure this route is protected by Cloudflare Access.',
        }, 401);
      } else {
        return c.html(`
          <html>
            <body>
              <h1>Unauthorized</h1>
              <p>Missing Cloudflare Access token.</p>
              <a href="https://${teamDomain}">Login</a>
            </body>
          </html>
        `, 401);
      }
    }

    // Verify JWT
    try {
      const payload = await verifyAccessJWT(jwt, teamDomain, expectedAud);
      c.set('accessUser', { email: payload.email, name: payload.name });
      await next();
    } catch (err) {
      console.error('Access JWT verification failed:', err);
      
      if (type === 'json') {
        return c.json({
          error: 'Unauthorized',
          details: err instanceof Error ? err.message : 'JWT verification failed',
        }, 401);
      } else {
        return c.html(`
          <html>
            <body>
              <h1>Unauthorized</h1>
              <p>Your Cloudflare Access session is invalid or expired.</p>
              <a href="https://${teamDomain}">Login again</a>
            </body>
          </html>
        `, 401);
      }
    }
  };
}
