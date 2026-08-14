/**
 * The first-run privacy contract, printed at the moment of decision — before the
 * board question and before any device flow. One pure function so the words are
 * test-pinned (test/privacyContract.test.ts): the can-leave list mirrors
 * contract/PRIVACY.md's one-line version, and a copy edit that drops a guarantee
 * fails loudly instead of shipping.
 *
 * Deliberately unstyled: callers own color/indentation, and the plain strings are
 * what the tests read. Keep it a screen, not a wall — the full field-by-field
 * disclosure lives in the contract, this is the honest summary at the doorstep.
 */
export function privacyContractLines(): string[] {
  return [
    "Before you decide — the capture contract, in plain terms:",
    "",
    "  Reads locally   your agent session logs — counters and timestamps, parsed here",
    "  Can leave       token counts, timestamps, model names, durations, a local repo hash",
    "  Never leaves    prompts, code, file names, working directories, credentials",
    "",
    "  Nothing is sent until you opt in below. Withdraw any time: `logout` removes the",
    "  device token, `uninstall` removes the hooks. Every claim above is a tested",
    "  whitelist you can read: contract/PRIVACY.md in the repository.",
  ];
}
