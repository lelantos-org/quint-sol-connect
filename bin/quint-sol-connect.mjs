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

import { loadConfig, buildModels } from '../src/config.mjs';
import { generateSpec, coverageReport, resolveQuint, quintVersion, TOOL_VERSION } from '../src/gen.mjs';
import { checkModel } from '../src/check.mjs';
import { emitDriverStub } from '../src/emit/scaffold.mjs';

const USAGE = `quint-sol-connect ${TOOL_VERSION}

  quint-sol-connect gen [specs...] [options]
      Regenerate trace fixtures and generated Solidity.
      --fresh          random seed instead of the config's pinned one
      --out DIR        write fixtures here instead of the configured path
      --traces N       override run.traces
      --steps N        override run.maxSteps
      --samples N      override run.maxSamples
      --seed X         override run.seed

  quint-sol-connect check [specs...]
      Verify committed fixtures and Solidity still match the config. No quint.

  quint-sol-connect scaffold <spec>
      Write a driver stub for a spec. Never overwrites an existing file.

  Common options:
      --config FILE    config path (default: quint-connect.config.mjs)
      --root DIR       project root (default: cwd)
      --runtime PATH   Solidity import prefix for the package's own contracts
                       (default: quint-sol-connect)
`;

function parseArgs(argv) {
  const opts = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      opts._.push(a);
      continue;
    }
    const key = a.slice(2);
    if (key === 'fresh') opts.flags.fresh = true;
    else opts.flags[key] = argv[++i];
  }
  return opts;
}

const die = (msg) => {
  console.error(`quint-sol-connect: ${msg}`);
  process.exit(1);
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }

  const { _: names, flags } = parseArgs(rest);
  const root = path.resolve(flags.root ?? process.cwd());
  const runtimeImport = flags.runtime ?? 'quint-sol-connect';

  const { config, file } = await loadConfig(root, flags.config);

  if (command === 'gen') {
    const models = buildModels(config, names);
    const quintBin = resolveQuint(config.quintBin);
    const quintVer = quintVersion(quintBin);

    const runOverride = {};
    if (flags.traces) runOverride.traces = Number(flags.traces);
    if (flags.steps) runOverride.maxSteps = Number(flags.steps);
    if (flags.samples) runOverride.maxSamples = Number(flags.samples);
    if (flags.seed) runOverride.seed = flags.seed;

    let dead = false;
    for (const model of models) {
      const cmd = `quint-sol-connect gen ${model.name}`;
      const summary = generateSpec(model, {
        root,
        quintBin,
        quintVer,
        fresh: Boolean(flags.fresh),
        outOverride: flags.out,
        runOverride,
        runtimeImport,
        cmd,
      });

      const steps = summary.fixtures.reduce((n, f) => n + f.steps, 0);
      console.log(
        `${model.name}: ${summary.fixtures.length} traces, ${steps} steps, seed ${summary.seed} ` +
          `(quint ${quintVer})`,
      );
      console.log(`  fixtures -> ${summary.fixtureDir}`);
      console.log(`  solidity -> ${model.solidityOut}`);
      const { lines, dead: never } = coverageReport(summary);
      for (const l of lines) console.log(l);
      if (never.length) {
        dead = true;
        console.error(
          `\n  WARNING: ${never.join(', ')} never ran in any trace.\n` +
            '  Either the action is unreachable in the spec (a guard that never holds), or it is\n' +
            '  configured but not in `step`. An action nothing exercises is coverage you do not have.',
        );
      }
      console.log('');
    }
    if (dead && config.failOnDeadAction) process.exit(1);
    return;
  }

  if (command === 'check') {
    const models = buildModels(config, names);
    let failed = false;
    for (const model of models) {
      const { problems, fixtures } = checkModel(model, root);
      if (problems.length === 0) {
        console.log(`${model.name}: ok (${fixtures} traces, schema ${model.schemaHash.slice(0, 10)})`);
      } else {
        failed = true;
        console.error(`${model.name}: ${problems.length} problem(s)`);
        for (const p of problems) console.error(`  - ${p}`);
      }
    }
    if (failed) {
      console.error('\nRegenerate with `quint-sol-connect gen`.');
      process.exit(1);
    }
    return;
  }

  if (command === 'scaffold') {
    const [name] = names;
    if (!name) die('scaffold needs a spec name');
    const [model] = buildModels(config, [name]);
    if (!model.driver?.path) die(`spec "${name}" has no \`driver.path\` in ${file}`);
    const target = path.resolve(root, model.driver.path);
    if (fs.existsSync(target)) {
      die(`${model.driver.path} already exists; scaffold never overwrites a driver`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, emitDriverStub(model, runtimeImport));
    console.log(`wrote ${model.driver.path}`);
    console.log('Fill in setUp, apply_ and _project, then run `quint-sol-connect gen`.');
    return;
  }

  die(`unknown command "${command}"\n\n${USAGE}`);
}

main().catch((e) => {
  if (e && e.name && e.message && !process.env.QCS_STACK) die(`${e.name}: ${e.message}`);
  throw e;
});
