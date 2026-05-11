#!/usr/bin/env node
/**
 * x_post.js — publish a tweet and return its URL and ID.
 *
 * Mode A — Official X API v2 (preferred, stable):
 *   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
 *
 * Mode B — Login/password via agent-twitter-client (fallback):
 *   X_USERNAME, X_LOGIN_PASSWORD (or legacy X_PASSWORD)
 *   Optional: X_EMAIL, X_LOGIN_2FA_SECRET (or legacy X_2FA_SECRET), X_COOKIE_PATH
 *
 * Mode C — Existing X session via cookies (most reliable: all cookies):
 *   X_COOKIES_JSON  — preferred: all browser cookies as JSON (name→value map, array of objects,
 *                     or array of Set-Cookie strings)
 *   X_AUTH_TOKEN + X_CT0  — minimal fallback (two cookies only, may be less reliable)
 *   Optional: X_COOKIE_PATH, X_USERNAME
 *
 * Usage:
 *   node x_post.js --text "tweet content" [--dry-run]
 *
 * Output (stdout): JSON { tweetId, tweetUrl, postedAt, mode }
 */

import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    text:      { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
  strict: true,
});

if (!values.text) { console.error('--text required'); process.exit(1); }

if (values['dry-run']) {
  const fakeId = String(Date.now());
  console.log(JSON.stringify({
    tweetId:  `dry_${fakeId}`,
    tweetUrl: `https://x.com/dry_run/status/dry_${fakeId}`,
    postedAt: new Date().toISOString(),
    mode:     'dry_run',
  }, null, 2));
  process.exit(0);
}

const hasApiKeys = !!(
  process.env.X_API_KEY &&
  process.env.X_API_SECRET &&
  process.env.X_ACCESS_TOKEN &&
  process.env.X_ACCESS_SECRET
);
const loginPassword = process.env.X_LOGIN_PASSWORD || process.env.X_PASSWORD || '';
const login2faSecret = process.env.X_LOGIN_2FA_SECRET || process.env.X_2FA_SECRET || '';
const hasCredentials = !!(process.env.X_USERNAME && loginPassword);
// Cookie session: X_COOKIES_JSON (preferred — all cookies) or X_AUTH_TOKEN+X_CT0 (minimal fallback)
const hasCookieSession = !!(process.env.X_COOKIES_JSON || (process.env.X_AUTH_TOKEN && process.env.X_CT0));

if (!hasApiKeys && !hasCredentials && !hasCookieSession) {
  console.error(
    'Provide one of:\n' +
    '  API keys:       X_API_KEY + X_API_SECRET + X_ACCESS_TOKEN + X_ACCESS_SECRET\n' +
    '  Cookie session: X_COOKIES_JSON (all cookies JSON) or X_AUTH_TOKEN + X_CT0\n' +
    '  Login:          X_USERNAME + X_LOGIN_PASSWORD',
  );
  process.exit(1);
}

if (hasApiKeys) {
  await postViaApiKey(values.text);
} else {
  await postViaScraper(values.text);
}

async function postViaApiKey(text) {
  const { TwitterApi } = await import('twitter-api-v2');
  const client = new TwitterApi({
    appKey:       process.env.X_API_KEY,
    appSecret:    process.env.X_API_SECRET,
    accessToken:  process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  });

  console.error('Posting tweet via API key...');
  const { data } = await client.v2.tweet(text);

  // Fetch own username for a clean URL
  let username = 'i/web';
  try {
    const me = await client.v2.me();
    username = me.data.username;
  } catch { /* non-critical */ }

  console.log(JSON.stringify({
    tweetId:  data.id,
    tweetUrl: `https://x.com/${username}/status/${data.id}`,
    postedAt: new Date().toISOString(),
    mode:     'api_key',
  }, null, 2));
}

async function postViaScraper(text) {
  const { Scraper } = await import('agent-twitter-client');
  const { readFile, writeFile } = await import('node:fs/promises');

  const scraper    = new Scraper();
  const cookiePath = (process.env.X_COOKIE_PATH || '.x_cookies.json').trim();

  // Try to reuse saved session
  let loggedIn = false;
  try {
    const rawCookies = await readFile(cookiePath, 'utf8');
    await scraper.setCookies(JSON.parse(rawCookies));
    loggedIn = await scraper.isLoggedIn();
    if (loggedIn) console.error('Reusing saved X session.');
  } catch { /* no cookies yet */ }

  if (!loggedIn && hasCookieSession) {
    console.error('Seeding X session from cookies...');
    const sessionCookies = buildSessionCookies();
    await scraper.setCookies(sessionCookies);
    loggedIn = await scraper.isLoggedIn();

    if (loggedIn) {
      try {
        const cookies = await scraper.getCookies();
        await writeFile(cookiePath, JSON.stringify(cookies, null, 2));
        console.error('Seeded session saved to', cookiePath);
      } catch { /* non-critical */ }
    } else {
      console.error('x_cookie_session_invalid: seeded ct0/auth_token session is not valid');
      process.exit(1);
    }
  }

  if (!loggedIn) {
    console.error('Logging in to X...');
    await scraper.login(
      process.env.X_USERNAME,
      loginPassword,
      process.env.X_EMAIL    || undefined,
      login2faSecret || undefined,
    );

    const isNowLoggedIn = await scraper.isLoggedIn();
    if (!isNowLoggedIn) {
      console.error('x_login_challenge_required: X login failed — may require manual 2FA or CAPTCHA');
      process.exit(1);
    }

    const cookies = await scraper.getCookies();
    await writeFile(cookiePath, JSON.stringify(cookies, null, 2));
    console.error('Session saved to', cookiePath);
  }

  console.error('Posting tweet via scraper...');
  const response = await scraper.sendTweet(text);
  const body     = await response.json();

  const tweetId = body?.data?.create_tweet?.tweet_results?.result?.rest_id;
  if (!tweetId) {
    console.error('Failed to extract tweet ID. Raw response:', JSON.stringify(body));
    process.exit(1);
  }

  const username = process.env.X_USERNAME || 'i/web';
  console.log(JSON.stringify({
    tweetId,
    tweetUrl: `https://x.com/${username}/status/${tweetId}`,
    postedAt: new Date().toISOString(),
    mode:     hasCookieSession ? 'cookie_session' : 'scraper',
  }, null, 2));
}

function buildSessionCookies() {
  // Primary: full cookie set from X_COOKIES_JSON — more reliable than just two cookies.
  // Accepted formats:
  //   A) JSON array of Set-Cookie strings: ["auth_token=xxx; Domain=.twitter.com; ...", ...]
  //   B) JSON array of objects:            [{"name":"auth_token","value":"xxx","domain":".twitter.com",...}, ...]
  //   C) JSON object (name→value map):     {"auth_token":"xxx","ct0":"yyy","twid":"u=zzz",...}
  const cookiesJson = (process.env.X_COOKIES_JSON || '').trim();
  if (cookiesJson) {
    let parsed;
    try {
      parsed = JSON.parse(cookiesJson);
    } catch {
      console.error('X_COOKIES_JSON is not valid JSON — falling back to X_AUTH_TOKEN + X_CT0');
    }
    if (parsed) {
      if (Array.isArray(parsed)) {
        return parsed.map(c => {
          if (typeof c === 'string') return c;
          // Object form — reconstruct a Set-Cookie string
          const domain = c.domain || '.twitter.com';
          const path   = c.path   || '/';
          let str = `${c.name}=${c.value}; Domain=${domain}; Path=${path}; Secure`;
          if (c.httpOnly) str += '; HttpOnly';
          return str;
        });
      }
      if (typeof parsed === 'object') {
        // name→value map — assume twitter.com scope for all
        return Object.entries(parsed).map(
          ([name, value]) => `${name}=${value}; Domain=.twitter.com; Path=/; Secure`,
        );
      }
    }
  }

  // Fallback: only the two critical cookies. May be less reliable.
  const authToken = (process.env.X_AUTH_TOKEN || '').trim();
  const ct0       = (process.env.X_CT0 || '').trim();
  if (!authToken || !ct0) {
    throw new Error('Cookie session requires X_COOKIES_JSON or both X_AUTH_TOKEN and X_CT0');
  }
  console.error('Warning: using X_AUTH_TOKEN + X_CT0 only. Prefer X_COOKIES_JSON with all browser cookies for reliability.');
  return [
    `auth_token=${authToken}; Domain=.twitter.com; Path=/; Secure; HttpOnly`,
    `ct0=${ct0}; Domain=.twitter.com; Path=/; Secure`,
  ];
}
