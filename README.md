# quint-sol-connect

Model-based testing for Solidity. Write a [Quint](https://quint-lang.org) spec of
what your contract is supposed to do, let Quint's simulator generate traces, and
replay them against the real contract **inside `forge test`**.

[quint-connect](https://github.com/quint-co/quint-connect) does this for Rust and
[a community port](https://github.com/marquesds/quint-connect) does it for Elixir.
This is the Solidity one.

```
quint run spec.qnt --mbt --out-itf
        |                                    (offline, node)
        v
test/fixtures/quint/<spec>/trace-000.json      ABI-encoded steps
test/fixtures/quint/<spec>/trace-000.itf.json  the verbatim ITF, for humans
test/quint/generated/*.sol                     types + replay loop + one test per trace
        |                                    (forge test - no node, no quint)
        v
one Foundry test per trace, asserting the model's state after every step
```

## Why the replay lives in Foundry

Generation is an offline step; **replay is not**. The traces become ordinary
Foundry tests that your existing `forge test` and your existing CI job pick up
with no new runtime, no anvil, and no node installed on the machine running them.
The only thing that needs the JS toolchain is regenerating.

## Install

```bash
npm install --save-dev @lelantos-org/quint-sol-connect
```

Quint ships as a dependency, so there is nothing else to install.

Then add the Solidity to your remappings — via npm:

```toml
remappings = ["quint-sol-connect/=node_modules/@lelantos-org/quint-sol-connect/solidity/"]
```

or, if you would rather pin a commit and keep `forge test` free of npm entirely,
as a git submodule under `lib/`:

```bash
git submodule add https://github.com/lelantos-org/quint-sol-connect lib/quint-sol-connect
```

```toml
remappings = ["quint-sol-connect/=lib/quint-sol-connect/solidity/"]
```

## The five minute version

A worked example lives in [`examples/counter`](examples/counter). It exercises
every value shape the tool lowers — an integer, an enum, a set, and a map to a
record — and it is the repo's own end-to-end test.

**1. Write the spec.** Three rules matter, because they are what `--mbt` needs:

```quint
action increment = {
  // Pick from a constant, non-empty domain, and put the guard *inside* the
  // action. `oneOf` on an empty set aborts the run, and picking an index into a
  // set would make the answer depend on iteration order.
  nondet by = 1.to(10).oneOf()
  all {
    status != Done,
    count' = count + by,
    ...
  }
}

// `step` is `any` over *bare named* actions. An inline `all { guard, action }`
// branch records no action name, and the trace cannot say what happened.
action step = any { increment, touch, finish }
```

**2. Describe the types.** Quint's types are richer than Solidity's in exactly
the directions that matter — unbounded integers, unordered sets, maps with
arbitrary keys — so someone has to choose a width and an order. That choice is
explicit:

```js
// quint-sol-connect.config.mjs
export default {
  specs: {
    counter: {
      spec: 'spec/counter.qnt',
      run: { traces: 12, maxSteps: 12, seed: '0x1a2b3c4d', invariant: 'allInvariants' },
      driver: { path: 'test/quint/CounterReplay.t.sol', contract: 'CounterReplay' },
      state: {
        count: 'uint256',
        status: { variant: ['Idle', 'Running', 'Done'], name: 'Status' },
        seen: { set: 'uint256' },
        entries: {
          map: { key: 'uint256', value: { record: { hits: 'uint256', flagged: 'bool' } } },
          entryName: 'EntriesEntry',
        },
      },
      actions: { increment: { by: 'uint256' }, touch: { key: 'uint256' }, finish: {} },
    },
  },
};
```

**3. Write the driver.** This is the only file you own. `quint-sol-connect
scaffold counter` writes a stub once and never touches it again.

```solidity
abstract contract CounterReplay is CounterSpecReplay {
    Counter internal counter;

    function setUp() public virtual {
        counter = new Counter();
    }

    function apply_(CounterSpec.Action action, CounterSpec.Picks memory picks) external override {
        require(msg.sender == address(this), "self-call only");
        if (action == CounterSpec.Action.Increment) counter.increment(picks.by);
        else if (action == CounterSpec.Action.Touch) counter.touch(picks.key);
        else if (action == CounterSpec.Action.Finish) counter.finish();
        else revert("unhandled action");
    }

    function _project() internal view override returns (CounterSpec.State memory s) {
        s.count = counter.count();
        s.status = CounterSpec.Status(uint8(counter.status()));
        s.seen = _ascending(counter.seen());   // see "Ordering" below
        ...
    }
}
```

**4. Generate and run.**

```bash
npx quint-sol-connect gen
forge test
```

## What a failure looks like

Two kinds, and the distinction is the first question of triage.

A **state divergence** — both sides ran, the results differ:

```
  entries[0].flagged: model=true chain=false

  MODEL / IMPLEMENTATION DIVERGENCE
    spec   : examples/counter/spec/counter.qnt
    trace  : examples/counter/fixtures/counter/trace-002.json
    itf    : examples/counter/fixtures/counter/trace-002.itf.json
    step   : 3 of 13
    action : touch
    fields : 1 diverged (listed above)

  reproduce:
    QUINT_VERBOSE=2 forge test --match-test test_quint_counter_002 -vvv
```

An **enabledness divergence** — the model thought the action was allowed and the
contract disagreed. Usually the model is missing a guard the contract has:

```
  ENABLEDNESS DIVERGENCE
    the model enabled `increment` at step 5; the implementation reverted
    revert : 0x1578538d
    ...
```

Every field is compared before the report, so one step names *everything* that
moved. Finding out that four fields moved together is a different diagnosis from
finding out that one did.

## Ordering

A Quint set is unordered and a Solidity array is not. The generator sorts sets
ascending and maps by key when it lowers a trace, and your `_project()` must
return the same order. Comparing unordered collections in an unspecified order is
the classic way for a model-based harness to produce failures that are not real,
so the order is fixed in one place and documented rather than left to chance.

## Commands

```
quint-sol-connect gen [specs...]      regenerate fixtures and Solidity
quint-sol-connect check [specs...]    verify committed output still matches the config
quint-sol-connect scaffold <spec>     write a driver stub, once
```

`--help` on any of them. `gen` takes `--fresh`, `--seed`, `--traces`, `--steps`
and `--samples` to override the config, plus two redirects:

- `--out <dir>` writes the fixtures elsewhere.
- `--sol-out <dir>` writes the per-trace contract elsewhere, and *only* that
  contract, named `<Name>FreshTraces`. Use both together for a scratch run: the
  committed per-trace contract embeds fixture paths, so redirecting only the
  fixtures would leave the committed suite pointing at a temporary directory.

`scaffold` writes the driver once and refuses to overwrite it, because the
driver is the one file you own. Every branch of the stub reverts rather than
returning a default — an unfilled branch has to fail loudly, since a stub that
returned zeros would compare clean against a freshly deployed contract and look
like a passing suite.

## Determinism

`run.seed` is pinned in the config, so regenerating an unchanged spec is a
byte-identical no-op. That is what lets you commit the fixtures and gate CI on:

```bash
quint-sol-connect gen && git diff --exit-code
```

`quint-sol-connect check` verifies committed fixtures still match the config
without running quint at all — it re-derives the schema hash and compares. The
hash covers the action names as well as the type string, because reordering
actions changes what each recorded `uint8` tag means while leaving the canonical
type byte-identical.

For a nightly sweep with real randomness, point a fresh run at scratch paths so
it cannot disturb any of that:

```bash
quint-sol-connect gen --fresh --out .scratch/fixtures --sol-out .scratch/sol
forge test --match-path ".scratch/sol/**"
```

## Coverage

`gen` prints how many steps each action actually took, and warns loudly about any
configured action that never ran:

```
  action     steps
  increment     75
  touch         66
  finish         3
```

An action nothing exercises is coverage you do not have. This is the generalised
form of a test handler that silently reverts on every call — the suite looks like
it covers the path, and nothing ever runs it.

## Why the trace is a hex blob

Fixtures hold ABI-encoded steps rather than readable JSON, and the verbatim ITF
is committed beside them. The alternatives were worse:

- **Raw ITF read with `vm.parseJson*`.** ITF keys are `#bigint`, `#map`, `#set`, `mbt::actionTaken`; `#map` is an array of tagged pairs. Consuming that means writing a recursive-descent JSON parser in Solidity, and each cheatcode re-parses the whole document.
- **Flattened JSON decoded into structs.** Inherits forge-std's type guessing: numbers become `uint256` (a `uint8` enum field will not decode), `0x…` strings become `address` or `bytes32` by *length*, and empty arrays are untypeable — which every trace's step 0 has. It also couples the struct's field order to alphabetical key order, with no compiler check.
- **Generated Solidity literals.** Best to debug, but hundreds of struct literals per trace add minutes to every build under `via_ir`.

The blob's one weakness is opacity, so a `schemaHash` is checked *before*
decoding: a config change that was not followed by a regeneration fails by name
instead of decoding into nonsense.

## Limits (v1)

- Types come from the config, not inferred from the Quint source.
- Variants must be payload-free (they lower to an `enum`).
- One level of nesting for maps and sets; no sets of records.
- `quint run` only — not `quint test` or `quint verify`.
- Quint does not shrink, so a failing trace is as long as it was generated.
- Replay needs `isolate = false`; the base contract checks and says so.
- The spec's own `pure val` constants are not emitted, so a driver that needs one keeps its own copy. A disagreement shows up as a divergence rather than passing quietly, but it is a second copy.

## In practice

The [Lelantos contracts](https://github.com/lelantos-org/contracts) use this
across three specs, which between them cover most of what the tool does:

| Spec | Shape it exercises | What the model caught |
| --- | --- | --- |
| `commitment_tree` | a `List`, a `Set`, 90-step traces past a 64-entry ring wrap | refuted a plausible-looking invariant in 13 ms — a root can sit in the ring and still be marked unknown |
| `nullifier_set` | a `Set` as the only variable, plus a negative action | — |
| `masp` | a map to a record, an enum, a driver shadow with cross-checks | reproduced a latent bug in the existing invariant suite: a handler whose every call reverted, silently, under `fail_on_revert = false` |

That last one is the case for the whole approach. An invariant run tells you a
property held at the end of it. It cannot tell you the contract agreed with a
model of itself at step 37, and it cannot tell the difference between a handler
that did nothing and a handler that was never called.

## Development

```bash
just install    # npm ci, including the pinned quint
just ci         # unit tests, drift check, determinism check, example replay
```

## Releasing

Publishing is a tag, not a command. `.github/workflows/publish.yml` runs the
full gate and publishes to GitHub Packages on any `v*` tag, and refuses a tag
that disagrees with `package.json`:

```bash
npm version patch      # or minor / major
git push --follow-tags
```

Consumers pinning by git submodule are on the commit, not the version, so a
release is only load-bearing for the npm channel.

## License

Apache-2.0, matching upstream quint-connect.
