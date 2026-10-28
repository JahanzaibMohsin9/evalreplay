// Each scenario from the family's first message to the closed case, scored by CarryPay's own
// evaluateRun checks (the same ones its eval script applies to live runs).
import { type Trace, defineCase } from '@evalreplay/core';

interface Check {
  id: string;
  label: string;
  pass: boolean;
}

const everyCheckPasses = (trace: Trace) => {
  const checks = (trace.output.structured as { checks?: Check[] } | undefined)?.checks;
  if (!checks?.length) return 'the run returned no CarryPay checks';
  const failed = checks.filter((c) => !c.pass);
  return failed.length === 0 || `failed CarryPay checks: ${failed.map((c) => c.label).join('; ')}`;
};

const scenarios = {
  'th-medical': 'Pakistan → Thailand, a heart procedure in Bangkok',
  'uk-tuition': 'China → United Kingdom, university fees in London',
  'pk-admission': 'Pakistan → United Kingdom, an offer through a consultant',
  'cn-admission': 'China → United Kingdom, a study agent promising a place',
};

export default Object.entries(scenarios).map(([scenario, description]) =>
  defineCase({
    id: `${scenario}-end-to-end`,
    description,
    vars: { scenario, wakeup: 'all' },
    input: `The whole ${scenario} scenario`,
    assert: [
      { no_tool_errors: true },
      { custom: { name: 'every CarryPay check passes', check: everyCheckPasses } },
    ],
  }),
);
