/**
 * A generic fixture extension module for test/cliExtension.test.ts. It exists to prove
 * bin/df.ts's loadExtension() hook (help append + commands dispatch) works for ANY module
 * satisfying its local CliExtension shape — deliberately unrelated to any real closed
 * extension that hook might also carry, so this fixture — and the public test that uses
 * it — can stay in the MIT export without ever naming one.
 *
 * Shape: satisfies bin/df.ts's local CliExtension interface —
 *   { help?: string[]; commands?: Record<string, (argv: string[]) => Promise<number>> }
 */

export const help: string[] = ["  npx --yes deploy-forward@latest fixture-cmd <arg>", "      a fixture-only command, present only when this test's extension file is used"];

export const commands: Record<string, (argv: string[]) => Promise<number>> = {
  "fixture-cmd": async (argv) => {
    process.stdout.write(`fixture-cmd ran with argv=${JSON.stringify(argv)}\n`);
    return 0;
  },
};
