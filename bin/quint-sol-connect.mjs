#!/usr/bin/env node
/**
 * quint-sol-connect CLI.
 *
 *   gen    [specs...]  generate trace fixtures and Solidity
 *   check  [specs...]  fail if committed output drifted from the config
 *   scaffold <spec>    write a driver stub, once
 */

import fs from 'node:fs';
import path from 'node:path';
import { Command, InvalidArgumentError } from 'commander';

import { loadConfig, buildModels } from '../src/config.mjs';
import { generateSpec, coverageReport, resolveQuint, quintVersion, TOOL_VERSION } from '../src/gen.mjs';
import { checkModel } from '../src/check.mjs';
import { emitDriverStub } from '../src/emit/scaffold.mjs';

/** A positive integer option, rejected at parse time rather than deep in quint. */
function positiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidArgumentError(`expected a positive integer, got "${value}"`);
  }
  return n;
}

const program = new Command();

program
  .name('quint-sol-connect')
  .description('Model-based testing for Solidity: replay Quint traces inside Foundry.')
  .version(TOOL_VERSION)
  // Inherited so they can be written either before or after the subcommand.
  .option('-c, --config <file>', 'config path (default: quint-sol-connect.config.mjs)')
  .option('-r, --root <dir>', 'project root (default: the working directory)')
  .option(
    '--runtime <prefix>',
    "Solidity import prefix for the package's own contracts",
    'quint-sol-connect',
  )
  .enablePositionalOptions()
  .showHelpAfterError();

/** Options declared on the root command, resolved for whichever subcommand ran. */
function common(command) {
  const opts = command.optsWithGlobals();
  return {
    root: path.resolve(opts.root ?? process.cwd()),
    configFile: opts.config,
    runtimeImport: opts.runtime,
  };
}

program
  .command('gen')
  .description('regenerate trace fixtures and generated Solidity')
  .argument('[specs...]', 'spec names from the config (default: all)')
  .option('--fresh', "use a random seed instead of the config's pinned one")
  .option('--out <dir>', 'write fixtures here instead of the configured path')
  .option(
    '--sol-out <dir>',
    'write only the per-trace contract here, leaving the committed Solidity alone',
  )
  .option('--traces <n>', 'override run.traces', positiveInt)
  .option('--steps <n>', 'override run.maxSteps', positiveInt)
  .option('--samples <n>', 'override run.maxSamples', positiveInt)
  .option('--seed <hex>', 'override run.seed')
  .action(async (specs, opts, command) => {
    const { root, configFile, runtimeImport } = common(command);
    const { config } = await loadConfig(root, configFile);
    const models = buildModels(config, specs);

    const quintBin = resolveQuint(config.quintBin);
    const quintVer = quintVersion(quintBin);

    const runOverride = {};
    if (opts.traces) runOverride.traces = opts.traces;
    if (opts.steps) runOverride.maxSteps = opts.steps;
    if (opts.samples) runOverride.maxSamples = opts.samples;
    if (opts.seed) runOverride.seed = opts.seed;

    let sawDeadAction = false;

    for (const model of models) {
      const summary = generateSpec(model, {
        root,
        quintBin,
        quintVer,
        fresh: Boolean(opts.fresh),
        outOverride: opts.out,
        solOutOverride: opts.solOut,
        runOverride,
        runtimeImport,
        cmd: `quint-sol-connect gen ${model.name}`,
        format: config.format,
      });

      const steps = summary.fixtures.reduce((n, f) => n + f.steps, 0);
      console.log(
        `${model.name}: ${summary.fixtures.length} traces, ${steps} steps, ` +
          `seed ${summary.seed} (quint ${quintVer})`,
      );
      console.log(`  fixtures -> ${summary.fixtureDir}`);
      console.log(
        `  solidity -> ${path.relative(root, summary.solDir) || '.'}` +
          `${summary.scratch ? ' (per-trace contract only)' : ''}` +
          `${summary.fmt?.formatted ? ' (forge fmt applied)' : ''}`,
      );
      if (summary.fmt && !summary.fmt.formatted) {
        console.log(`  note: not formatted - ${summary.fmt.reason}`);
      }

      const { lines, dead } = coverageReport(summary);
      for (const l of lines) console.log(l);
      if (dead.length) {
        sawDeadAction = true;
        console.error(
          `\n  WARNING: ${dead.join(', ')} never ran in any trace.\n` +
            '  Either the action is unreachable in the spec (a guard that never holds), or it is\n' +
            '  configured but not in `step`. An action nothing exercises is coverage you do not have.',
        );
      }
      console.log('');
    }

    if (sawDeadAction && config.failOnDeadAction) process.exitCode = 1;
  });

program
  .command('check')
  .description('verify committed fixtures and Solidity still match the config (no quint)')
  .argument('[specs...]', 'spec names from the config (default: all)')
  .action(async (specs, _opts, command) => {
    const { root, configFile } = common(command);
    const { config } = await loadConfig(root, configFile);
    const models = buildModels(config, specs);

    let failed = false;
    for (const model of models) {
      const { problems, fixtures } = checkModel(model, root);
      if (problems.length === 0) {
        console.log(
          `${model.name}: ok (${fixtures} traces, schema ${model.schemaHash.slice(0, 10)})`,
        );
      } else {
        failed = true;
        console.error(`${model.name}: ${problems.length} problem(s)`);
        for (const p of problems) console.error(`  - ${p}`);
      }
    }
    if (failed) {
      console.error('\nRegenerate with `quint-sol-connect gen`.');
      process.exitCode = 1;
    }
  });

program
  .command('scaffold')
  .description('write a driver stub for a spec; never overwrites an existing file')
  .argument('<spec>', 'spec name from the config')
  .action(async (name, _opts, command) => {
    const { root, configFile, runtimeImport } = common(command);
    const { config, file } = await loadConfig(root, configFile);
    const [model] = buildModels(config, [name]);

    if (!model.driver?.path) {
      throw new Error(`spec "${name}" has no \`driver.path\` in ${file}`);
    }
    const target = path.resolve(root, model.driver.path);
    if (fs.existsSync(target)) {
      throw new Error(`${model.driver.path} already exists; scaffold never overwrites a driver`);
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, emitDriverStub(model, runtimeImport));
    console.log(`wrote ${model.driver.path}`);
    console.log('Fill in setUp, apply_ and _project, then run `quint-sol-connect gen`.');
  });

// Errors from the pipeline are diagnoses, not stack traces: config mistakes,
// spec shapes --mbt cannot describe, values that do not fit their declared
// width. Print the message and exit. `QCS_STACK=1` restores the stack when the
// bug is in the tool itself rather than in what it was given.
try {
  await program.parseAsync(process.argv);
} catch (e) {
  if (process.env.QCS_STACK || !e?.message) throw e;
  console.error(`quint-sol-connect: ${e.name && e.name !== 'Error' ? `${e.name}: ` : ''}${e.message}`);
  process.exit(1);
}
