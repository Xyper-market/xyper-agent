#!/usr/bin/env node
/**
 * poll_status.js — snapshot agent state: submissions, campaigns, referral rewards.
 *
 * Required env vars:
 *   XYPER_API_BASE    e.g. https://api.xyper.market
 *   XYPER_AGENT_TOKEN agentSessionToken from wallet_auth.js
 *
 * Usage:
 *   node poll_status.js [--mode submissions|campaigns|referral|all]
 *
 * Output (stdout): JSON with current state and actionable items summary.
 * The orchestrating agent reads this to decide what to do next.
 */

import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    mode: { type: 'string', default: 'all' },
  },
  strict: true,
});

const apiBase    = (process.env.XYPER_API_BASE || '').replace(/\/$/, '');
const agentToken = (process.env.XYPER_AGENT_TOKEN || '').trim();

if (!apiBase)    { console.error('XYPER_API_BASE required');    process.exit(1); }
if (!agentToken) { console.error('XYPER_AGENT_TOKEN required'); process.exit(1); }

const headers = { 'Authorization': `Bearer ${agentToken}` };

async function agentGet(path) {
  const res = await fetch(`${apiBase}${path}`, { headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET ${path} HTTP ${res.status}: ${json.detail ?? JSON.stringify(json)}`);
  return json;
}

const mode   = values.mode;
const report = { timestamp: new Date().toISOString(), mode };

// Submissions: validating, approved, claimable, claimed
if (mode === 'submissions' || mode === 'all') {
  const data = await agentGet(
    '/api/agent/v1/me/submissions/?status=submitted,validating,approved,claimable',
  );
  const list = data.results ?? data;
  report.submissions = {
    total:      list.length,
    byStatus:   groupBy(list, 'status'),
    claimable:  list.filter(s => s.status === 'claimable').map(pick('id', 'campaign_id', 'status', 'post_url')),
    validating: list.filter(s => s.status === 'validating').map(pick('id', 'status')),
  };
  report.nextActions = report.nextActions ?? [];
  if (report.submissions.claimable.length > 0) {
    report.nextActions.push({
      type:    'claim_submission_reward',
      items:   report.submissions.claimable.map(s => s.id),
      message: `${report.submissions.claimable.length} submission(s) ready to claim`,
    });
  }
}

// Campaigns: live and not yet joined
if (mode === 'campaigns' || mode === 'all') {
  const data = await agentGet('/api/agent/v1/campaigns/?status=live&joined=false');
  const list = data.results ?? data;
  report.newCampaigns = list.map(pick('id', 'title', 'chain_id', 'token_symbol', 'status'));
  report.nextActions  = report.nextActions ?? [];
  if (list.length > 0) {
    report.nextActions.push({
      type:    'join_campaign',
      items:   list.map(c => c.id),
      message: `${list.length} live campaign(s) available to join`,
    });
  }
}

// Referral rewards
if (mode === 'referral' || mode === 'all') {
  const data = await agentGet('/api/agent/v1/me/referral/rewards/');
  const list = data.results ?? data;
  const claimable = list.filter(r => r.claimable);
  report.referralRewards = {
    total:    list.length,
    claimable: claimable.map(pick('rewardId', 'rewardType', 'token', 'amountUsd', 'status')),
  };
  report.nextActions = report.nextActions ?? [];
  if (claimable.length > 0) {
    report.nextActions.push({
      type:    'claim_referral_reward',
      message: `${claimable.length} referral reward(s) ready to claim`,
    });
  }
}

// Summarise
report.hasPendingActions = (report.nextActions?.length ?? 0) > 0;

console.log(JSON.stringify(report, null, 2));

// ── helpers ──────────────────────────────────────────────────────────────────

function groupBy(arr, key) {
  return arr.reduce((acc, item) => {
    const k = item[key] ?? 'unknown';
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
}

function pick(...keys) {
  return obj => Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]]));
}
