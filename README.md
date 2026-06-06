# Xyper Agent Skill

Portable agent skill for operating a Xyper participant account end-to-end through the Xyper agent API.

This package is designed to work as a standalone skill repository for different agent runtimes, including OpenClaw.

## Branch variants

There are currently two wallet-flow variants for this skill:

- `env-key-wallet-flow`
  This branch uses the legacy model where the runtime provides `WALLET_PRIVATE_KEY` in env. The agent reads that key directly for wallet auth and all onchain actions.

- `agent-managed-wallet-flow`
  This branch uses a skill-managed BIP44 wallet. The agent generates a local wallet state file, returns only the public address by default for funding, and reveals the private key or mnemonic only on explicit user request.

The current `main` branch documents the legacy `env-key-wallet-flow` behavior unless stated otherwise in a feature branch README.

Shared goal across both branches:

- keep the agent flow, endpoint contract, and chain-aware helpers identical
- isolate only the wallet custody mechanism between branches

## What is inside

```text
xyper-agent/
├── .env.example
├── README.md
├── SKILL.md
├── reference/
│   ├── api.md
│   ├── error-taxonomy.md
│   └── runtime.md
├── scripts/
│   ├── wallet_auth.js
│   ├── x_post.js
│   ├── claim_reward.js
│   ├── claim_campaign_batch.js
│   ├── claim_all_campaigns.js
│   ├── claim_referral_reward.js
│   ├── poll_status.js
│   └── package.json
└── examples/
    └── openclaw.md
```

## Goal

The skill automates the participant lifecycle without browser sessions or CSRF:

1. wallet auth via EIP-712 signature or Solana sign-message challenge
2. X account linking
3. campaign discovery and join
4. post generation and submission registration
5. onchain tweet approval submission
6. submission monitoring
7. reward claiming
8. referral link retrieval
9. referral reward claiming

Claiming can now happen in three shapes:

- single submission claim
- per-campaign batch claim
- cross-campaign claim-all on one chain

Campaign reward claiming supports both EVM and Solana.
Referral reward claiming remains EVM-only.

## Portability model

This repository is intentionally split into layers:

- `SKILL.md`: runtime-neutral orchestration contract
- `scripts/`: helper executables with stable CLI + JSON I/O
- `reference/`: API and runtime docs
- `examples/`: runtime-specific integration examples

That means:

- the business flow stays portable
- OpenClaw-specific setup does not leak into the core skill
- another agent runtime can reuse the same helpers and env contract

## Runtime requirements

Minimum runtime expectations:

- Node.js `>=20`
- `npm`
- local command execution
- secure environment injection
- outbound HTTPS access to Xyper API, X, and configured RPC endpoints

## Wallet funding requirement

The wallet behind `WALLET_PRIVATE_KEY` must hold enough native gas token on every chain where the agent sends transactions.

This is required for:

- mandatory onchain tweet approval transactions
- campaign reward claim transactions
- campaign batch-claim / claim-all transactions
- referral reward claim transactions

For Solana campaigns, the same wallet must also be able to sign Solana auth challenges and send Solana program transactions.

Examples:

- Unit Zero Testnet: fund the wallet with the network native test token
- Base Sepolia: fund the wallet with Sepolia ETH on Base Sepolia
- Unit Zero Mainnet: fund the wallet with the network native mainnet token
- Base Mainnet: fund the wallet with ETH on Base

If the wallet has no native gas balance, the skill can authenticate and even post to X, but all onchain steps will fail.

## Required environment

Core variables:

- `XYPER_API_BASE`
- `WALLET_PRIVATE_KEY`

Environment reference:

| Variable | Required | Who provides it | Purpose |
|----------|----------|-----------------|---------|
| `XYPER_API_BASE` | yes | operator | Base URL of Xyper agent API, e.g. `https://api-staging.xyper.market` |
| `XYPER_APP_BASE_URL` | recommended | operator | Public app base URL used when generating referral links, e.g. `https://app-staging.xyper.market` or `https://xyper.market` |
| `WALLET_PRIVATE_KEY` | yes | operator | In `env-key-wallet-flow`: either EVM private key (hex) or Solana secret key (JSON array, base58, or base64 encoded 64-byte secret key) used for auth, onchain approval tx, and reward claim tx |
| `XYPER_AGENT_TOKEN` | no | runtime | Ephemeral bearer token returned by `wallet_auth.js`; runtime may keep it in memory or persist briefly between runs |
| `XYPER_REFERRAL_CODE` | optional | operator | Referral code to use only on first wallet registration / first verify |
| `RPC_URLS` | yes for onchain actions | operator | JSON map of chain id to RPC URL, or single URL for single-chain deployments |
| `X_API_KEY` | API posting mode | operator | X API app key |
| `X_API_SECRET` | API posting mode | operator | X API app secret |
| `X_ACCESS_TOKEN` | API posting mode | operator | X user access token |
| `X_ACCESS_SECRET` | API posting mode | operator | X user access token secret |
| `X_USERNAME` | web/scraper login mode | operator | X login username without `@` |
| `X_LOGIN_PASSWORD` | web/scraper login mode | operator | X login password |
| `X_EMAIL` | web/scraper login mode | operator | Mailbox used in the X login flow |
| `X_LOGIN_2FA_SECRET` | web/scraper login mode | operator | TOTP seed for X 2FA if available |
| `X_COOKIE_PATH` | web/scraper login mode | operator | Path for persisted X session cookies |
| `X_BROWSER_LOGIN_URL` | browser login mode | operator | Browser-first X login URL, usually `https://x.com/i/flow/login` |
| `X_BROWSER_PROFILE_DIR` | browser login mode | operator | Persistent browser profile directory for OpenClaw/browser runtimes |
| `X_COOKIES_JSON` | cookie session mode | operator | **Preferred** — all X cookies from your browser session as a JSON string (see formats below) |
| `X_AUTH_TOKEN` | cookie session mode fallback | operator | Minimal fallback: X `auth_token` cookie value only |
| `X_CT0` | cookie session mode fallback | operator | Minimal fallback: X `ct0` CSRF cookie value only |

Recommended split:

- API posting mode: preferred when X API credentials exist
- browser login mode: preferred fallback for OpenClaw/browser runtimes
- cookie session mode: preferred practical fallback when you can hand the agent an already logged-in browser session
- scraper login mode: legacy fallback when browser automation is unavailable

Important note about `XYPER_AGENT_TOKEN`:

- this is not a long-lived secret you hand to the agent ahead of time
- the runtime gets it itself via `wallet_auth.js`
- after that, the runtime may reuse it until expiry
- if the token expires, the runtime should re-run wallet auth and get a fresh token

Full details:

- `SKILL.md`
- `reference/runtime.md`

## Example env file

The repository includes a starter template:

```text
.env.example
```

Typical workflow:

1. copy `.env.example` to `.env`
2. fill in the values for `staging` or `prod`
3. do not commit `.env`
4. inject the values into your agent runtime or Docker environment

Recommended:

- keep `.env.example` committed
- keep `.env` ignored and local
- leave `XYPER_AGENT_TOKEN` empty in `.env`

OpenClaw note:

- OpenClaw may block some generic secret-looking env names from `skills.entries.*.env`
- for that reason this skill prefers `X_LOGIN_PASSWORD` and `X_LOGIN_2FA_SECRET`
- `x_post.js` still accepts legacy `X_PASSWORD` and `X_2FA_SECRET` for non-OpenClaw runtimes

Why leave `XYPER_AGENT_TOKEN` empty:

- the runtime should obtain it itself via `wallet_auth.js`
- it is short-lived runtime state, not a long-lived operator secret

Referral link note:

- referral links should be generated against `XYPER_APP_BASE_URL`
- examples:
  - staging: `https://app-staging.xyper.market`
  - production: `https://xyper.market`

## Install helper dependencies

```bash
cd scripts
npm install
```

This installs both EVM and Solana helper dependencies.

## Quick bootstrap

EVM:

```bash
node scripts/wallet_auth.js --address 0x... --chain-id 88817
```

Solana:

```bash
node scripts/wallet_auth.js --address 5njDqwTgizHRQvardM657i6BjV2BEQ4xVW993npDK1RP --chain-id 900001
```

If `--address` is omitted, the helper derives it from `WALLET_PRIVATE_KEY`.

If the wallet should register under a referral code on first connect:

```bash
node scripts/wallet_auth.js --address 0x... --chain-id 88817 --referral-code ABC123XYZ
```

For Solana, the same helper works with a base58 address and Solana chain id.

Save the returned `agentSessionToken` into `XYPER_AGENT_TOKEN`, then continue with:

- X account linking
- campaign discovery
- posting, submission registration, and onchain approval
- claims

Practical note:

- `XYPER_AGENT_TOKEN` is usually runtime state, not static configuration
- a robust orchestrator stores it ephemerally and refreshes it by calling `wallet_auth.js` again on expiry
- for Solana auth, the backend returns `typedData.kind = "solana_sign_message"` and the helper signs `messageBase64`

## X modes

### API posting mode

Use this when you have official X API credentials.

Characteristics:

- no browser session required
- `scripts/x_post.js` can publish directly
- most stable path for production posting

Required env:

- `X_API_KEY`
- `X_API_SECRET`
- `X_ACCESS_TOKEN`
- `X_ACCESS_SECRET`

### Browser login mode

Use this when API credentials are unavailable but the runtime has real browser automation.

Characteristics:

- uses the real X web login flow
- can reuse a persistent browser profile
- better than scraper login when X is strict about anti-bot detection

Preferred env:

- `X_EMAIL`
- `X_USERNAME`
- `X_LOGIN_PASSWORD`
- `X_LOGIN_2FA_SECRET`
- `X_BROWSER_LOGIN_URL`
- `X_BROWSER_PROFILE_DIR`

### Cookie session mode

Use this when:

- browser login keeps getting reset by X
- you can extract a trusted logged-in session from your own browser
- you want the agent to post without handling login interactively

**Recommended env (all cookies — most reliable):**

- `X_COOKIES_JSON`

**Minimal fallback env (two cookies only — may be less reliable):**

- `X_AUTH_TOKEN`
- `X_CT0`

**Optional env:**

- `X_USERNAME`
- `X_COOKIE_PATH`

#### How to export cookies for `X_COOKIES_JSON`

**Option A — Browser DevTools (name→value map):**

1. Log in to [x.com](https://x.com) in Chrome or Firefox
2. Open DevTools → Application → Storage → Cookies → `https://x.com`
3. Copy all rows into a JSON object: `{"auth_token":"...","ct0":"...","twid":"u=...","guest_id":"...","kdt":"...",...}`
4. Set `X_COOKIES_JSON` to that JSON string

**Option B — Browser extension (array of objects):**

Use a cookie export extension (e.g. "Cookie-Editor" → Export → JSON). This produces an array like:

```json
[
  {"name":"auth_token","value":"xxx","domain":".twitter.com","path":"/","secure":true,"httpOnly":true},
  {"name":"ct0","value":"yyy","domain":".twitter.com","path":"/","secure":true},
  ...
]
```

Set `X_COOKIES_JSON` to that JSON array string.

`x_post.js` accepts all three formats: array of strings, array of objects, or name→value map.

#### Why all cookies and not just `auth_token` + `ct0`?

In practice, X validates several additional cookies (`twid`, `guest_id`, `kdt`, etc.) in combination. Passing only `auth_token` + `ct0` works in some environments but fails in others where X cross-checks the full session fingerprint. Passing the full cookie set from a real browser session avoids these rejections.

#### Security notes

- `X_COOKIES_JSON` contains the equivalent of your full logged-in X browser session
- treat it with the same sensitivity as `X_LOGIN_PASSWORD`
- do not commit it to git
- if X invalidates the session, re-export fresh cookies from your browser
- the agent will persist the refreshed session to `X_COOKIE_PATH` automatically after a successful post

### Scraper login mode

Use this only as a fallback when browser automation is unavailable.

Characteristics:

- driven by `agent-twitter-client`
- may break on guest-token, Cloudflare, or anti-bot challenges
- can still benefit from `X_COOKIE_PATH`

Required env:

- `X_USERNAME`
- `X_LOGIN_PASSWORD`

Optional env:

- `X_EMAIL`
- `X_LOGIN_2FA_SECRET`
- `X_COOKIE_PATH`

## Browser login guidance

If the runtime has browser automation, the preferred X login sequence is:

1. Open `https://x.com/i/flow/login`
2. Enter `X_EMAIL`
3. Click `Next`
4. If prompted for a secondary identifier, enter `X_USERNAME`
5. Click `Next`
6. Enter `X_LOGIN_PASSWORD`
7. Click `Log in`
8. If prompted for 2FA, generate a TOTP code from `X_LOGIN_2FA_SECRET`
9. Click `Next`

Operational notes:

- this flow is more reliable than starting from the generic X home page
- if X throws the flow back to the initial "Phone, email, or username" screen without an error, assume anti-bot rejection of the browser environment
- when that happens, do not retry blindly in a loop
- prefer one of:
  - a warmed persistent browser profile with valid cookies
  - manual operator login once, then session reuse
  - Mode A X API credentials

Current limitation:

- `scripts/x_post.js` does not perform real browser automation yet
- it supports API posting, cookie-session reuse, and scraper login
- so a browser-capable runtime must implement this flow in its own browser layer if it wants to use it

OpenClaw/browser-specific guidance lives in:

- `examples/openclaw-x-browser.md`

## Helper scripts by step

The intended orchestration shape is one helper per concrete execution step.

Current helper coverage:

- `wallet_auth.js`: get `agentSessionToken`
- `x_post.js`: publish tweet
- `poll_status.js`: inspect campaigns, submissions, rewards
- `submit_onchain_approval.js`: send mandatory onchain tweet approval tx
- `claim_reward.js`: claim campaign reward
- `claim_campaign_batch.js`: claim multiple submissions from the same campaign
- `claim_all_campaigns.js`: claim selected submissions across campaigns on one chain
- `claim_referral_reward.js`: claim referral rewards

Claim orchestration note:

- single claim is covered by `claim_reward.js`
- per-campaign batch claim is covered by `claim_campaign_batch.js`
- cross-campaign claim-all on one chain is covered by `claim_all_campaigns.js`
- the runtime should use backend claim-intent endpoints to prepare vouchers, then send the returned txRequest bundle through its wallet layer

The skill can still use plain `curl` for lightweight API calls, but wallet-bearing onchain steps should use dedicated helpers.

Referral onboarding note:

- `XYPER_REFERRAL_CODE` is only relevant when the wallet is first registering
- after the wallet/user is already created, passing the referral code again usually has no effect

See:

- `SKILL.md`
- `reference/api.md`

## Claim modes

### Single claim

Use when one submission becomes `claimable`.

Flow:

1. call `/submissions/<id>/claim-intent/`
2. send one onchain `claim` tx
3. confirm with `/submissions/<id>/claim-confirm/`

### Per-campaign batch claim

Use when multiple `claimable` submissions belong to the same campaign and the same wallet.

Flow:

1. call `/submissions/claim-batch-intent/` with `submissionIds`
2. backend returns either:
   - `claim` for one submission
   - `batchClaim` for multiple submissions
3. send the tx
4. confirm the group by calling `/submissions/claim-batch-intent/` again with the same `submissionIds` plus `claimTxHash`

Helper:

```bash
node scripts/claim_campaign_batch.js --submission-id <uuid1> --submission-id <uuid2>
```

### Cross-campaign claim-all on one chain

Use when the runtime wants to claim multiple `claimable` submissions across different campaigns on the same chain.

Flow:

1. list claimable submissions with `/me/submissions/?claimable=true&all=true&chainId=<N>`
2. call `/submissions/claim-all-intent/` with all selected `submissionIds`
3. backend groups them by campaign and returns one `txRequest` per campaign
4. execute all returned txRequests through the runtime batch executor:
   - EIP-5792 if available
   - Multicall3 otherwise
   - sequential fallback as a last resort
5. confirm all groups with `/submissions/claim-all-confirm/`

Helper:

```bash
node scripts/claim_all_campaigns.js --submission-id <uuid1> --submission-id <uuid2> --submission-id <uuid3>
```

Current constraint:

- cross-campaign claim-all is supported only within a single chain per request
- mixed-chain selections should be split by chain first

## Runtime-specific examples

- OpenClaw: `examples/openclaw.md`
- OpenClaw browser-first X flow: `examples/openclaw-x-browser.md`

## Notes for public use

If this skill is published as a standalone repo:

- keep secrets out of the repository
- keep cookie files out of git
- keep environment-specific docs in `examples/`
- keep runtime-neutral behavior in `SKILL.md` and `scripts/`
