# OpenClaw Browser-First X Flow

This document describes the recommended X login and posting strategy for OpenClaw deployments when scraper-based login is unreliable.

Use this playbook when:

- `agent-twitter-client` hits guest-token or Cloudflare issues
- the agent has access to browser automation in OpenClaw
- `X_LOGIN_2FA_SECRET` is available
- the operator wants human-in-the-loop control over campaign participation

## Goal

Keep the core Xyper skill portable, but give OpenClaw a runtime-specific browser playbook for:

1. logging into X through the real web flow
2. reusing the browser session when possible
3. posting proof tweets and campaign tweets
4. escalating cleanly when X rejects the browser environment

## Required env

Recommended values in `skills.entries.xyper-agent.env`:

```json5
{
  X_USERNAME: "your_handle_without_at",
  X_LOGIN_PASSWORD: "REPLACE_ME",
  X_EMAIL: "you@example.com",
  X_LOGIN_2FA_SECRET: "REPLACE_ME",
  X_COOKIE_PATH: "/opt/openclaw/config/xyper-staging-x-cookies.json",
  X_BROWSER_LOGIN_URL: "https://x.com/i/flow/login",
  X_BROWSER_PROFILE_DIR: "/opt/openclaw/config/xyper-staging-x-browser-profile"
}
```

Notes:

- `X_BROWSER_LOGIN_URL` should usually stay `https://x.com/i/flow/login`
- `X_BROWSER_PROFILE_DIR` should be stable per X account
- `X_COOKIE_PATH` is still useful even if scraper login is not the primary path

## Login sequence

The runtime should prefer this exact sequence:

1. Open `X_BROWSER_LOGIN_URL`
2. Wait for the login flow to render
3. Enter `X_EMAIL`
4. Click `Next`
5. If X asks for a secondary identifier, enter `X_USERNAME`
6. Click `Next`
7. Enter `X_LOGIN_PASSWORD`
8. Click `Log in`
9. If prompted for 2FA, generate a TOTP code from `X_LOGIN_2FA_SECRET`
10. Click `Next`
11. Confirm that the session reaches the logged-in home timeline or compose UI

Expected success signal:

- the account avatar, left-nav, or compose surface is visible

## Anti-bot detection

Treat these as environment-level failures, not ordinary bad credentials:

- X returns to the initial "Phone, email, or username" screen without an error
- the password step never appears after identifier entry
- a Cloudflare block page appears
- the browser is allowed to load X, but every login attempt silently resets

When this happens:

1. Stop automated retries
2. Report that the environment looks suspicious to X
3. Reuse existing cookies/profile if available
4. Fall back to manual operator login once, then reuse the warmed session

## Session reuse strategy

Preferred order:

1. Reopen the persistent browser profile from `X_BROWSER_PROFILE_DIR`
2. Check whether X is already logged in
3. If yes, skip login and proceed straight to posting
4. If not, run the login sequence above
5. After a successful login, keep using the same profile for future posting tasks

This matters because:

- X is much more tolerant of a warm profile than repeated cold logins
- 2FA becomes less frequent once a stable session exists
- posting proof tweets and campaign tweets becomes much more reliable

## Posting contract

For both proof tweets and campaign tweets, the browser runtime should return a compact machine-readable result to the orchestrator:

```json
{
  "ok": true,
  "mode": "browser",
  "tweetId": "1912345678901234567",
  "tweetUrl": "https://x.com/handle/status/1912345678901234567",
  "postedAt": "2026-05-11T18:22:10.000Z"
}
```

If blocked:

```json
{
  "ok": false,
  "mode": "browser",
  "error": "x_browser_login_reset",
  "detail": "X returned to the initial identifier step before password entry"
}
```

## Operator workflow in Telegram or UI

Recommended control style:

1. Ask the agent to check whether the X browser session is already valid
2. If not, ask it to attempt browser login using the stored X env vars
3. If login succeeds, ask it to post the proof tweet or campaign tweet
4. If login fails with anti-bot symptoms, ask it to stop and report the exact step where the flow reset
5. If needed, log in manually once and let the agent reuse the warmed session afterward

## Suggested prompt phrasing

For validation:

```text
Use the xyper-agent browser-first X flow. Reuse the persistent browser profile if possible. If not logged in, open https://x.com/i/flow/login, enter X_EMAIL, then X_USERNAME if asked, then X_LOGIN_PASSWORD, then TOTP from X_LOGIN_2FA_SECRET. Stop if X resets back to the first identifier screen, and tell me exactly where it reset.
```

For proof posting:

```text
Use the xyper-agent browser-first X flow to log into X or reuse the existing session. Then post the Xyper proof tweet text I give you and return only the tweet URL, tweet id, and postedAt timestamp.
```

For campaign posting:

```text
Use the xyper-agent browser-first X flow. Reuse the persistent X session if available. Post the campaign tweet exactly as prepared, then continue with submission registration and onchain approval.
```

## Practical rollout advice

For the first rollout:

- keep campaign participation human-approved
- let the agent discover campaigns and report them
- approve which campaign to join
- let the agent attempt browser posting
- if browser posting works, continue with submission and onchain approval
- if browser posting fails, post manually once and let the agent continue from the tweet URL

This gives you a safe bridge between fully manual X usage and later full automation.
