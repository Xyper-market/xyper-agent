---
name: xyper-agent
description: Operate a Xyper participant agent end-to-end: generate a session-scoped BIP44 EVM wallet, fund it, authenticate via EIP-712, link X, join campaigns, post tweets, register submissions, send mandatory onchain tweet-approval transactions, fetch referral links, monitor claimable rewards, and claim campaign and referral payouts on supported EVM chains. Use when an agent needs to automate the full Xyper participant lifecycle against the agent API without browser sessions or CSRF.
metadata: {"openclaw":{"requires":{"bins":["node","npm"],"env":["XYPER_API_BASE"]}}}
allowed-tools: Read, Grep, Glob, Bash(node scripts/*), Bash(npm *), Bash(curl *), WebFetch
---

## Purpose

This skill automates every step a human participant performs on Xyper, but without a browser:

1. Connect wallet (EIP-712 sign → agentSessionToken)
2. Link X account (post proof tweet → submit URL)
3. Discover and join live campaigns
4. Generate and publish campaign tweet; register submission
5. Submit mandatory onchain tweet approval tx and confirm it
6. Monitor submission validation and scoring status
7. Claim campaign reward (send EVM tx → confirm tx hash)
8. Retrieve referral link and deliver to owner
9. Monitor referral rewards; claim when available

Campaign reward claiming supports:

- single submission claim
- per-campaign batch claim
- cross-campaign claim-all on one chain

All interaction with the platform uses `Authorization: Bearer <agentSessionToken>` — no cookies, no CSRF.

## Portability contract

This skill is intentionally written to be portable across agent runtimes.

The portability boundary is:

- the agent reads this `SKILL.md`
- the agent can read files under this skill directory
- the agent can execute local helper scripts
- the agent can provide environment variables securely
- the agent can read and write a local wallet-state file
- the agent can parse JSON from stdout

This skill does not require OpenClaw-specific tools or RPC formats in its core flow.
OpenClaw is one supported runtime, but not the only intended one.

To keep the skill portable:

- do not hardcode platform-specific absolute paths
- do not assume OpenClaw-only config keys inside the operational flow
- do not assume browser state, cookies, or CSRF for Xyper API access
- prefer helper scripts and plain HTTP over runtime-specific tool plugins

## Runtime requirements

Any agent runtime using this skill should provide:

- filesystem access to this skill directory
- Node.js `>=20`
- `npm` for installing helper dependencies
- ability to run local commands in `scripts/`
- secure environment-variable injection
- outbound HTTPS access to Xyper APIs, X, and configured RPC endpoints

The runtime should also allow the skill to persist one local wallet-state file for the current session.

OpenClaw note:

- OpenClaw can load this skill from `<workspace>/skills/xyper-agent`
- OpenClaw can inject env via `skills.entries.xyper-agent.env`
- OpenClaw can gate eligibility via `metadata.openclaw.requires`

Non-OpenClaw runtimes should treat `metadata.openclaw` as optional metadata and may ignore it.

## Secrets and config

This skill now uses a local managed wallet file instead of a wallet private key env var.

Wallet material lives in a JSON state file created by `wallet_helper.js`. Other credentials still live in environment variables. Never hardcode them.

| Variable | Required | Description |
|----------|----------|-------------|
| `XYPER_API_BASE` | yes | e.g. `https://api.xyper.market` |
| `XYPER_APP_BASE_URL` | recommended | Base URL used for referral links, e.g. `https://app-staging.xyper.market` or `https://xyper.market` |
| `XYPER_WALLET_STATE_PATH` | optional | Path to the managed wallet JSON file. Default: `<skill-root>/.xyper-agent-wallet.json` |
| `XYPER_AGENT_TOKEN` | runtime-generated | Bearer token returned by `wallet_auth.js`; runtime may persist it briefly and refresh on expiry |
| `XYPER_REFERRAL_CODE` | optional | Referral code to use during first wallet verify only |
| `RPC_URLS` | for claims | JSON map `{"88817":"https://rpc.unit0.dev"}` or single URL |
| `X_API_KEY` | API posting mode | X developer app key |
| `X_API_SECRET` | API posting mode | X developer app secret |
| `X_ACCESS_TOKEN` | API posting mode | X user access token |
| `X_ACCESS_SECRET` | API posting mode | X user access token secret |
| `X_USERNAME` | web/scraper login mode | X account username (without @) |
| `X_LOGIN_PASSWORD` | web/scraper login mode | X account password |
| `X_EMAIL` | web/scraper login mode | X account email used in the login flow |
| `X_LOGIN_2FA_SECRET` | web/scraper login mode | TOTP secret for 2FA accounts |
| `X_COOKIE_PATH` | web/scraper login mode | Path to persist session cookies (default `.x_cookies.json`) |
| `X_BROWSER_LOGIN_URL` | browser login mode | Browser-first X login URL, usually `https://x.com/i/flow/login` |
| `X_BROWSER_PROFILE_DIR` | browser login mode | Persistent browser profile directory for browser-capable runtimes |
| `X_COOKIES_JSON` | cookie session mode | **Preferred** — all X cookies from your browser as a JSON string (name→value map, array of objects, or array of Set-Cookie strings). More reliable than passing only two cookies. |
| `X_AUTH_TOKEN` | cookie session mode fallback | Minimal fallback: X `auth_token` cookie value. Use `X_COOKIES_JSON` instead when possible. |
| `X_CT0` | cookie session mode fallback | Minimal fallback: X `ct0` CSRF cookie value. Use `X_COOKIES_JSON` instead when possible. |

X posting strategies are intentionally split:

- API posting mode: use official X API credentials and let `x_post.js` publish without browser state
- cookie session mode: seed `x_post.js` with `X_COOKIES_JSON` (all browser cookies) from an already logged-in session; `X_AUTH_TOKEN` + `X_CT0` is a minimal fallback but less reliable in practice
- web login mode: use a real browser flow for X login and session reuse
- scraper login mode: use `agent-twitter-client` only as a fallback when browser automation is unavailable

Cookie session reliability note:

X validates several cookies together in some environments (`twid`, `guest_id`, `kdt`, etc.). Passing only `auth_token` + `ct0` works in many cases but fails in others where X cross-checks the full session fingerprint. Passing the full cookie set from a real browser session via `X_COOKIES_JSON` avoids these rejections. See `README.md` for export instructions.

Compatibility note:

- for OpenClaw deployments prefer `X_LOGIN_PASSWORD` and `X_LOGIN_2FA_SECRET`
- helper scripts keep backward compatibility with legacy `X_PASSWORD` and `X_2FA_SECRET`

Recommended portable additions in the orchestrator layer:

- `XYPER_ENV` = `staging` or `prod`
- `XYPER_OWNER_LABEL` = human-readable owner or deployment label

These are optional and not required by the helper scripts, but are useful for multi-environment automation.

## Scripts

Install once: `cd skills/xyper-agent/scripts && npm install`

All scripts output JSON to stdout and errors to stderr. Exit code 0 = success.

| Script | Purpose |
|--------|---------|
| `wallet_helper.js` | Generate / inspect / explicitly export the skill-managed BIP44 EVM wallet |
| `wallet_auth.js` | EIP-712 sign → get `agentSessionToken` |
| `x_post.js` | Publish tweet → return `{ tweetId, tweetUrl, postedAt }` |
| `submit_onchain_approval.js` | Use `onchain-intent` response → send mandatory tweet approval tx → confirm hash |
| `claim_reward.js` | Claim campaign reward → send EVM tx → confirm hash |
| `claim_campaign_batch.js` | Claim multiple claimable submissions from one campaign |
| `claim_all_campaigns.js` | Claim selected claimable submissions across campaigns on one chain |
| `claim_referral_reward.js` | Claim referral rewards (batched) → send EVM tx → confirm hash |
| `poll_status.js` | Check submissions, claimable items, new campaigns |

Helper script contract:

- inputs: CLI flags + environment variables
- stdout: exactly one JSON object on success
- stderr: diagnostics only
- exit code `0`: success
- exit code non-zero: failure

Any agent runtime can orchestrate the skill as long as it can respect that contract.

Native gas requirement:

- the managed wallet generated by `wallet_helper.js` must hold enough native coin on the target chain for every onchain transaction
- this includes onchain tweet approval and all claim transactions
- this also includes `batchClaim` and claim-all execution bundles
- if native balance is missing, the API steps may succeed while the onchain helper scripts fail

## Flows

### 1. Bootstrap — first run

```
node scripts/wallet_helper.js generate
```

Save the returned `address` and fund it with native gas on each target chain. The helper stores secrets only in the local wallet-state file. It does not print the private key or mnemonic unless explicitly asked later with:

```
node scripts/wallet_helper.js export --secret private-key
node scripts/wallet_helper.js export --secret mnemonic
```

Then authenticate:

```
node scripts/wallet_auth.js --chain-id 88817
```

If the wallet should be registered under a referral code on first connect:

```
node scripts/wallet_auth.js --chain-id 88817 --referral-code ABC123XYZ
```

Save returned `agentSessionToken` as `XYPER_AGENT_TOKEN`.

If `XYPER_REFERRAL_CODE` is present in the runtime environment and the wallet has not been registered yet, the orchestrator should pass that value to `wallet_auth.js --referral-code ...` on the first verify attempt only.

Then check X session:
- API posting mode: verify credentials by calling `GET /api/agent/v1/x/session/validate/`
- cookie session mode: run `node scripts/x_post.js --text "test" --dry-run` and then a real proof/campaign post when ready
- scraper login mode: `node scripts/x_post.js --text "test" --dry-run` (no tweet sent)
- browser login mode: use the browser playbook below and confirm X is already logged in or can reach the compose UI

### 2. Link X account (if not yet verified)

Browser login mode for browser-capable runtimes:

1. Open `https://x.com/i/flow/login`
2. Enter the account email from `X_EMAIL`
3. Click `Next`
4. If X asks for a secondary identifier, enter `X_USERNAME`
5. Click `Next`
6. Enter `X_LOGIN_PASSWORD`
7. Click `Log in`
8. If prompted for TOTP, generate a code from `X_LOGIN_2FA_SECRET`
9. Click `Next`

Important operator notes:

- use this exact URL, not the generic X home page
- prefer a headful browser session or an already-warmed persistent profile
- if X resets the flow back to the first "Phone, email, or username" step without an error, treat that as anti-bot / browser-environment rejection
- in that case do not loop endlessly; fall back to persisted cookies or manual operator assistance
- the current `x_post.js` helper does not implement this browser login flow; it only supports API posting mode and scraper login mode
- if a runtime has browser automation tools, it should prefer the browser playbook above over scraper login

```
# Step 1 — create challenge
curl -X POST $XYPER_API_BASE/api/agent/v1/social/x/link/start/ \
  -H "Authorization: Bearer $XYPER_AGENT_TOKEN" \
  -d '{"walletAddress":"<managed wallet address>"}'
# → { challengeId, code: "XYPR-ABCDEF", expiresAt }

# Step 2 — post proof tweet
node scripts/x_post.js --text "Linking my wallet to Xyper. XYPR-ABCDEF"
# → { tweetId, tweetUrl }

# Step 3 — complete challenge
curl -X POST $XYPER_API_BASE/api/agent/v1/social/x/link/complete/ \
  -H "Authorization: Bearer $XYPER_AGENT_TOKEN" \
  -d '{"challengeId":123,"tweetUrl":"https://x.com/.../status/..."}'

# Step 4 — poll status until verified
curl $XYPER_API_BASE/api/agent/v1/social/x/link/status/123/ \
  -H "Authorization: Bearer $XYPER_AGENT_TOKEN"
```

### 3. Campaign discovery and join

```
# Get live campaigns not yet joined
node scripts/poll_status.js --mode campaigns
# → { newCampaigns: [...] }

# Join campaign
curl -X POST $XYPER_API_BASE/api/agent/v1/campaigns/<id>/join/ \
  -H "Authorization: Bearer $XYPER_AGENT_TOKEN"
# → { participationId, status, nextAction }
```

### 4. Post tweet and submit

```
# Post tweet (generate text from campaign requirements)
node scripts/x_post.js --text "<campaign tweet text>"
# → { tweetId, tweetUrl, postedAt }

# Register submission
curl -X POST $XYPER_API_BASE/api/agent/v1/campaigns/<id>/submissions/ \
  -H "Authorization: Bearer $XYPER_AGENT_TOKEN" \
  -d '{
    "walletAddress": "<managed wallet address>",
    "platform": "x",
    "postUrl": "<tweetUrl>",
    "externalPostId": "<tweetId>",
    "contentText": "<tweet text>",
    "postedAt": "<postedAt>",
    "source": "agent"
  }'
```

### 5. Mandatory onchain tweet approval

After submission registration, the runtime must request onchain approval intent, send the approval tx, and confirm the tx hash back to Xyper.

```
# Send approval tx and confirm it
node scripts/submit_onchain_approval.js --submission-id <uuid>
# → { approvalTxHash, submissionId, status: "approved_onchain" }
```

This onchain step is part of the normal X submission lifecycle and should not be skipped.

### 6. Monitor and claim campaign reward

```
# Poll until claimable
node scripts/poll_status.js --mode submissions
# → { claimable: [{ id, campaignId, ... }] }

# Claim
node scripts/claim_reward.js --submission-id <uuid>
# → { claimTxHash, status: "claimed" }
```

#### 6a. Per-campaign batch claim

Use when multiple `claimable` submissions belong to the same campaign and wallet.

```
# Prepare the campaign-scoped batch
curl -X POST $XYPER_API_BASE/api/agent/v1/submissions/claim-batch-intent/ \
  -H "Authorization: Bearer $XYPER_AGENT_TOKEN" \
  -d '{
    "submissionIds": ["<uuid1>", "<uuid2>"]
  }'
# → { submissionIds, claims, txRequest }

# txRequest.method will be:
# - claim
# - batchClaim

# After sending the tx, confirm the same group
curl -X POST $XYPER_API_BASE/api/agent/v1/submissions/claim-batch-intent/ \
  -H "Authorization: Bearer $XYPER_AGENT_TOKEN" \
  -d '{
    "submissionIds": ["<uuid1>", "<uuid2>"],
    "claimTxHash": "0x..."
  }'
```

Helper:

```
node scripts/claim_campaign_batch.js --submission-id <uuid1> --submission-id <uuid2>
# → { claimTxHash, submissionIds, method, status: "claimed" }
```

#### 6b. Cross-campaign claim-all on one chain

Use when the runtime wants to claim multiple `claimable` submissions across different campaigns on the same chain.

```
# Step 1 — discover claimable submissions on one chain
curl "$XYPER_API_BASE/api/agent/v1/me/submissions/?claimable=true&all=true&chainId=84532" \
  -H "Authorization: Bearer $XYPER_AGENT_TOKEN"

# Step 2 — prepare all campaign groups in one round-trip
curl -X POST $XYPER_API_BASE/api/agent/v1/submissions/claim-all-intent/ \
  -H "Authorization: Bearer $XYPER_AGENT_TOKEN" \
  -d '{
    "submissionIds": ["<uuid1>", "<uuid2>", "<uuid3>"]
  }'
# → { chainId, groups: [{ campaignId, submissionIds, claims, txRequest }, ...] }

# Step 3 — execute every returned txRequest through the runtime batch executor
# Runtime strategy:
# - EIP-5792 if supported
# - Multicall3 if available on the chain
# - sequential writes as fallback

# Step 4 — confirm all prepared groups
curl -X POST $XYPER_API_BASE/api/agent/v1/submissions/claim-all-confirm/ \
  -H "Authorization: Bearer $XYPER_AGENT_TOKEN" \
  -d '{
    "groups": [
      { "submissionIds": ["<uuid1>", "<uuid2>"], "claimTxHash": "0x..." },
      { "submissionIds": ["<uuid3>"], "claimTxHash": "0x..." }
    ]
  }'
```

Helper:

```
node scripts/claim_all_campaigns.js --submission-id <uuid1> --submission-id <uuid2> --submission-id <uuid3>
# → { chainId, groups, status: "claimed" }
```

Constraints:

- `claim-all-intent` supports one chain per request
- if submissions span multiple chains, split them by `chainId` first
- each returned group is still campaign-scoped because `batchClaim` is campaign-contract scoped

### 7. Referral link

```
curl "$XYPER_API_BASE/api/agent/v1/me/referral/?walletAddress=0x...&baseUrl=$XYPER_APP_BASE_URL" \
  -H "Authorization: Bearer $XYPER_AGENT_TOKEN"
# → { profile: { referralLink: "$XYPER_APP_BASE_URL?ref=XYZ..." } }
```

Send `referralLink` to owner via webhook / Telegram / email.

### 8. Referral reward claim

```
node scripts/poll_status.js --mode all
# → { claimableReferralRewards: [...] }

node scripts/claim_referral_reward.js
# → { claimTxHash, status: "claimed" }
```

## Error handling

See `reference/error-taxonomy.md` for machine-readable error codes.

On any script failure: check stderr, inspect returned JSON `detail` field. Common recoverable errors:
- `agent_session_expired` → re-run `wallet_auth.js`
- `x_login_challenge_required` → handle 2FA manually or check `X_LOGIN_2FA_SECRET`
- `claim_not_ready` → wait and retry
- `mixed_chains_not_supported` → split claim-all by `chainId`

## OpenClaw compatibility

This skill should remain compatible with OpenClaw while staying runtime-neutral.

Compatibility rules:

- keep the skill directory self-contained
- keep helper invocation based on local `node scripts/...`
- keep secrets in env vars or the managed wallet state file, not in prompt text
- keep outputs machine-readable JSON
- use OpenClaw-specific metadata only as optional gating metadata, not as part of the business flow

If adapting this skill for another runtime, preserve:

- the environment-variable contract
- the managed wallet-state contract
- the helper script interface
- the API-first orchestration pattern

That will keep behavior aligned across OpenClaw and non-OpenClaw agents.

## Reference docs

- `README.md` — package overview and repo structure
- `reference/api.md` — full agent API endpoint catalogue
- `reference/runtime.md` — script internals, multi-chain config, retry policy
- `reference/error-taxonomy.md` — error code catalogue
- `examples/openclaw.md` — OpenClaw-specific attachment example
- `examples/openclaw-x-browser.md` — OpenClaw browser-first X login and posting playbook
