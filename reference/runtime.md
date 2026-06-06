---
purpose: Runtime internals — how wallet signing, X automation, multi-chain tx, and retry policy work
---

# Runtime Reference

## Node.js scripts

All scripts are ES modules (`"type": "module"` in package.json). Node.js ≥ 20 required.

```
skills/xyper-agent/scripts/
├── package.json
├── wallet_auth.js
├── x_post.js
├── submit_onchain_approval.js
├── claim_reward.js
├── claim_referral_reward.js
└── poll_status.js
```

Install: `npm install` (inside `scripts/`).

Scripts communicate only through:
- stdin: not used
- stdout: JSON result (single object)
- stderr: diagnostic messages
- exit code: 0 success / 1 error

The orchestrating Claude agent reads stdout JSON and decides next steps.

---

## Wallet / signing

Libraries:

- EVM: `viem`
- Solana: `@solana/web3.js`, `@solana/spl-token`, `tweetnacl`, `bs58`

### EIP-712 sign (wallet_auth.js)

viem's `account.signTypedData()` requires that `EIP712Domain` is **not** present in the `types` map — it's handled internally. The script strips it before calling:

```js
const { EIP712Domain, ...types } = typedData.types;
const signature = await account.signTypedData({ domain, types, primaryType, message });
```

### Solana sign-message auth (wallet_auth.js)

For Solana auth, backend returns:

- `typedData.kind = "solana_sign_message"`
- `typedData.messageBase64`

The helper signs the decoded message bytes with the Solana secret key and sends the resulting base58 signature to `/auth/wallet/verify/`.

### Sending claim transactions

Backend's `claim-intent` endpoints return a fully-encoded `txRequest` — the agent does NOT need to sign typed data; it only needs to send the transaction as the wallet owner.

```js
const txHash = await walletClient.sendTransaction({
  to: txRequest.to,
  data: txRequest.data,
  value: BigInt(txRequest.value || 0),
});
await publicClient.waitForTransactionReceipt({ hash: txHash });
```

For Solana, the runtime sends the returned program instruction bundle, including backend Ed25519 proof and, when needed, idempotent ATA creation.

### Sending mandatory onchain tweet-approval transactions

For X campaign submissions, the normal lifecycle includes an onchain approval step:

1. call `/api/agent/v1/submissions/{id}/onchain-intent/`
2. receive `approval` payload and `txRequest`
3. send the approval transaction as the wallet owner
4. call `/api/agent/v1/submissions/{id}/onchain-confirm/` with `approvalTxHash`

The runtime does not need browser state for this. It only needs:

- `WALLET_PRIVATE_KEY`
- the returned `chainId`
- a matching RPC URL from `RPC_URLS`

The repository provides a dedicated helper for this step:

```bash
node scripts/submit_onchain_approval.js --submission-id <uuid>
```

As with reward claims, the runtime is the wallet executor; backend prepares the intent.

### Native gas balance

The wallet used by the skill must have enough native coin on the target chain to pay gas for:

- onchain tweet approval
- campaign reward claims
- referral reward claims

Without native gas balance:

- auth can still work
- X posting can still work
- backend intent endpoints can still work
- transaction send steps will fail

### Multi-chain RPC config

`RPC_URLS` env var accepts two formats:

**Format A — JSON map (preferred for multi-chain):**
```
RPC_URLS={"88817":"https://rpc.unit0.dev","1":"https://eth-mainnet.alchemyapi.io/v2/KEY"}
```

**Format B — single URL (single-chain setups):**
```
RPC_URLS=https://rpc.unit0.dev
```

Scripts parse the `chainId` from the backend response and look up the matching RPC URL.

### Gas policy

Scripts use `viem`'s default gas estimation. No custom gas price overrides in MVP. If a transaction reverts or underprices, the script exits with code 1 and logs the error.

---

## X automation

The repository supports three operational paths:

1. API posting mode
2. cookie session mode
3. browser login mode
4. scraper login mode

### API posting mode — Official X API v2 (preferred)

Package: `twitter-api-v2`

Required env vars: `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`.

These are **per-user** OAuth 1.0a credentials, not app-level. Each agent account needs its own access token pair. Obtain via X Developer Portal.

Rate limits (free/basic tier): check current X API pricing. For campaign automation, Basic plan ($100/mo) gives sufficient write access.

### Cookie session mode — reuse an existing logged-in browser session

Required env vars: `X_AUTH_TOKEN`, `X_CT0`.

Optional: `X_USERNAME`, `X_COOKIE_PATH`.

This mode seeds `agent-twitter-client` with a pre-existing authenticated X web session.

Use it when:

- the operator can copy cookies from their own trusted browser session
- direct login from the agent runtime keeps getting blocked
- the runtime should post without running the X login flow

Security note:

- `X_AUTH_TOKEN` and `X_CT0` together are effectively a live logged-in X session
- treat them like full account credentials
- rotate them if they are ever exposed

### Scraper login mode — login/password via agent-twitter-client

Package: `agent-twitter-client`

Required env vars: `X_USERNAME`, `X_PASSWORD`.
Preferred for OpenClaw: `X_USERNAME`, `X_LOGIN_PASSWORD`.
Backward-compatible legacy names: `X_PASSWORD`.
Optional: `X_EMAIL` (for login email confirmation), `X_LOGIN_2FA_SECRET` (preferred), `X_2FA_SECRET` (legacy), `X_COOKIE_PATH`.
Optional for browser-capable runtimes: `X_BROWSER_LOGIN_URL`, `X_BROWSER_PROFILE_DIR`.

This mode uses the scraper approach. X may present anti-bot challenges. Mitigations:
- Persist session cookies in `X_COOKIE_PATH` (default `.x_cookies.json`) — the script does this automatically
- On challenge, script exits with error code 1 and `x_login_challenge_required` in stderr
- If `X_LOGIN_2FA_SECRET` or legacy `X_2FA_SECRET` is set, TOTP is handled automatically
- Use a stable IP / proxy per account; rotating IPs increase challenge likelihood

Cookie persistence flow:
1. Script attempts to load cookies from `X_COOKIE_PATH`
2. Checks `scraper.isLoggedIn()`; if true, uses cached session
3. If session invalid, performs fresh login and saves new cookies
4. On successful tweet, updates cookie file

### Browser login mode for runtimes with web automation

If the agent runtime has real browser automation, prefer this login path over scraper login:

1. Open `https://x.com/i/flow/login`
2. Enter `X_EMAIL`
3. Click `Next`
4. If asked for a secondary identifier, enter `X_USERNAME`
5. Click `Next`
6. Enter `X_LOGIN_PASSWORD`
7. Click `Log in`
8. If prompted for 2FA, generate TOTP from `X_LOGIN_2FA_SECRET`
9. Click `Next`

Guidance:

- use this exact login URL instead of the generic X landing page
- use a persistent browser profile so successful login can be reused
- if X resets the login flow back to the initial identifier prompt without a visible error, treat that as environment-level anti-bot rejection rather than a bad credential
- when that happens, stop automated retries and escalate to one of:
  - operator-assisted login to warm cookies
  - a less suspicious egress/browser environment
  - Mode A official X API credentials

Important limitation:

- this repository does not yet ship a browser automation helper for X
- `x_post.js` is still API/scraper based
- browser-capable runtimes must implement the browser layer themselves if they want to use this fallback

### Dry-run mode

Both modes support `--dry-run`. Script outputs a fake result without actually posting. Useful for testing the orchestration flow.

---

## Session token lifecycle

`agentSessionToken` format: `xy_agt_{43 url-safe chars}` (~51 chars total).
TTL: `XY_AGENT_SESSION_TTL_SECONDS` (default 86400 s / 24 h).

Strategy:
1. On startup, try to use a previously cached token if available.
2. If no token is cached, run `wallet_auth.js`.
3. If any API call returns 401 with `agent_session_expired`, re-run `wallet_auth.js` and persist the new token.
4. Treat the token as runtime state, not as a static operator-provided secret.

---

## Retry policy (recommended)

Scripts themselves do not retry internally — they fail fast and let the orchestrator decide.

Recommended orchestrator retry strategy:
- Network errors: 3 retries with exponential backoff (1s, 2s, 4s)
- `claim_not_ready`: wait 60s, retry (up to configured max)
- `duplicate_submission`: do not retry; skip
- `x_login_challenge_required`: pause, alert owner, do not retry automatically
- `claim_tx_reverted`: inspect tx receipt, alert owner

---

## Security

- Private keys and X passwords exist only in env vars — never in files committed to git
- Cookie files (`X_COOKIE_PATH`) contain session tokens; add to `.gitignore`
- `agentSessionToken` can be revoked server-side by calling `DELETE /api/agent/v1/auth/session/` (post-MVP)
- Consider OS keychain or a secrets manager (1Password, Vault) for production deployments
