import { defineConfig } from '@evalreplay/core';
import { agent } from './carrypay.js';

export default defineConfig({
  cases: 'cases/**/*.{yaml,case.ts}',
  name: 'carrypay',
  version: '4fb5b91',
  agent,
  // CarryPay's code was written for one sandbox world per process: run one at a time
  concurrency: 1,
  timeoutMs: 10 * 60_000,
  // With CARRYPAY_AGENT=live, Claude calls are priced by the Anthropic recorder. For DeepSeek or
  // OpenAI, add their current prices (USD per million tokens) here, or the cost stays unknown:
  // prices: { 'deepseek-v4-pro': { input: ..., output: ..., cachedInput: ... } },
});
