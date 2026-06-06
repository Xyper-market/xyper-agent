# OpenClaw Example Flow

This document shows one concrete way to attach `xyper-agent` to an OpenClaw deployment without making the skill itself OpenClaw-specific.

## What OpenClaw provides

OpenClaw can:

- load the skill from `<workspace>/skills/xyper-agent`
- restrict skill visibility with `agents.defaults.skills` and `agents.list[].skills`
- inject host-run env vars with `skills.entries.xyper-agent.env`
- inspect skills with:
  - `openclaw skills list`
  - `openclaw skills check`
  - `openclaw skills info xyper-agent`

OpenClaw docs used for this flow:

- `https://docs.openclaw.ai/tools/skills`
- `https://docs.openclaw.ai/tools/skills-config`
- `https://docs.openclaw.ai/cli/skills`

## Recommended workspace layout

```text
<workspace>/
└── skills/
    └── xyper-agent/
        ├── README.md
        ├── SKILL.md
        ├── reference/
        ├── scripts/
        └── examples/
```

## Install helper dependencies

```bash
cd <workspace>/skills/xyper-agent/scripts
npm install
```

## Using `.env.example`

The skill package includes `.env.example` in its root.

Recommended flow:

1. copy `.env.example` to `.env`
2. fill it for `staging` or `prod`
3. use that file as the source of truth for values you inject into OpenClaw

Example:

```bash
cd <workspace>/skills/xyper-agent
cp .env.example .env
```

Important:

- do not commit `.env`
- keep `XYPER_AGENT_TOKEN` empty there
- the runtime should obtain `XYPER_AGENT_TOKEN` dynamically via `wallet_auth.js`
- if you want browser-first X login, also set `X_BROWSER_LOGIN_URL` and `X_BROWSER_PROFILE_DIR`
- if you want to reuse your own logged-in X session, set `X_AUTH_TOKEN` and `X_CT0`

## Minimal OpenClaw config

```json5
{
  agents: {
    defaults: {
      skills: ["xyper-agent"]
    },
    list: [
      {
        id: "main",
        skills: ["xyper-agent"]
      }
    ]
  },
  skills: {
    entries: {
      "xyper-agent": {
        enabled: true,
        env: {
          XYPER_API_BASE: "https://api-staging.xyper.market",
          WALLET_PRIVATE_KEY: "REPLACE_ME",
          RPC_URLS: "{\"UNITZERO_TESTNET_CHAIN_ID\":\"https://rpc-testnet.unit0.dev\",\"84532\":\"https://base-sepolia.gateway.tenderly.co\"}",
          X_COOKIE_PATH: "/opt/openclaw/config/xyper-staging-x-cookies.json",
          X_BROWSER_LOGIN_URL: "https://x.com/i/flow/login",
          X_BROWSER_PROFILE_DIR: "/opt/openclaw/config/xyper-staging-x-browser-profile"
        }
      }
    }
  }
}
```

If your Docker/OpenClaw deployment already supports `env_file`, you can also keep the values in a host-side `.env` and map them into the container environment first, then mirror the needed values into `skills.entries.xyper-agent.env`.

In practice, `skills.entries.xyper-agent.env` is still the clearest way to make the skill see those values at runtime.

For the browser-first X path, also see:

- `examples/openclaw-x-browser.md`

For the user-browser-session path:

- export `auth_token` and `ct0` from a trusted logged-in browser session
- map them to `X_AUTH_TOKEN` and `X_CT0`
- let `x_post.js` seed `X_COOKIE_PATH` from those values on first use

## Environment split

### Staging

- `XYPER_API_BASE=https://api-staging.xyper.market`
- Unit Zero Testnet RPC: `https://rpc-testnet.unit0.dev`
- Base Sepolia RPC: `https://base-sepolia.gateway.tenderly.co`
- separate staging X account
- separate staging private key

### Production

- `XYPER_API_BASE=https://api.xyper.market`
- Unit Zero Mainnet RPC: `https://rpc.unit0.dev`
- Base Mainnet RPC: `https://base-mainnet.infura.io/v3/470d580ee1074d6781ee598194d9bd4b`
- separate prod X account
- separate prod private key

## Recommendation for staging/prod

Best option:

- run separate OpenClaw deployments for `staging` and `prod`

Acceptable fallback:

- duplicate the skill under two names:
  - `xyper-agent-staging`
  - `xyper-agent-prod`

Why:

- `skills.entries.<skill>.env` is skill-key scoped
- a single OpenClaw config is awkward for two secret sets under one skill name

## Verification

Check that OpenClaw sees the skill:

```bash
openclaw skills list
openclaw skills check
openclaw skills info xyper-agent
```

Check that helpers work:

```bash
cd <workspace>/skills/xyper-agent/scripts
node wallet_auth.js --address 0x... --chain-id REPLACE_CHAIN_ID
node wallet_auth.js --address 5njDqwTgizHRQvardM657i6BjV2BEQ4xVW993npDK1RP --chain-id 900001
```

## Sandbox note

If the OpenClaw agent is sandboxed:

- `skills.entries.xyper-agent.env` only applies to host runs
- sandbox env must also be provided through sandbox config

For first rollout, prefer host execution for this skill.

## Keep the boundary clean

To preserve portability:

- keep OpenClaw specifics in this example doc and OpenClaw config
- keep business logic in `SKILL.md`
- keep executable behavior in `scripts/`
