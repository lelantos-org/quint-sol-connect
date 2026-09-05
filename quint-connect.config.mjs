// Config for this repo's own example. Doubles as the reference for the format.
export default {
  // Where `quint` lives. null = the copy bundled with this package, then PATH.
  quintBin: null,

  solidityOut: 'examples/counter/test/generated',
  fixtureOut: 'examples/counter/fixtures',
  pragma: '^0.8.20',

  specs: {
    counter: {
      spec: 'examples/counter/spec/counter.qnt',
      module: 'counter',

      // Pinned seed: regenerating an unchanged spec is a no-op diff, which is
      // what lets CI gate on `gen && git diff --exit-code`. `--fresh` overrides
      // it for the nightly sweep.
      run: {
        traces: 12,
        maxSteps: 12,
        maxSamples: 5000,
        seed: '0x1a2b3c4d',
        invariant: 'allInvariants',
      },

      driver: {
        path: 'examples/counter/test/CounterReplay.t.sol',
        contract: 'CounterReplay',
      },

      // Solidity types for each Quint state variable, in the order the
      // generated `State` struct should declare them.
      state: {
        count: 'uint256',
        status: { variant: ['Idle', 'Running', 'Done'], name: 'Status' },
        // A Quint set is unordered; the generator sorts it ascending so the
        // model and the implementation are compared in one fixed order.
        seen: { set: 'uint256' },
        // A map lowers to an array of entries sorted by key, with the key
        // flattened alongside the value's fields.
        entries: {
          map: {
            key: 'uint256',
            value: { record: { hits: 'uint256', flagged: 'bool' }, name: 'Entry' },
          },
          entryName: 'EntriesEntry',
        },
      },

      // Action names must match `mbt::actionTaken` exactly. This order pins the
      // generated `Action` enum.
      actions: {
        increment: { by: 'uint256' },
        touch: { key: 'uint256' },
        finish: {},
      },
    },
  },
};
