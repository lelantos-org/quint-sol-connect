// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { Counter } from "../src/Counter.sol";

import { CounterSpec } from "./generated/CounterSpec.sol";
import { CounterSpecReplay } from "./generated/CounterSpecReplay.sol";

/// Driver for `examples/counter/spec/counter.qnt`.
///
/// This is the whole of what a human writes: deploy the system, translate one
/// model action into a call, and read the implementation back into the model's
/// vocabulary. Everything else is generated or lives in the package.
///
/// `abstract` so Foundry does not collect it as a test contract; the generated
/// `CounterTraces` inherits it and holds one test per trace.
abstract contract CounterReplay is CounterSpecReplay {
    Counter internal counter;

    function setUp() public virtual {
        counter = new Counter();
        // Nothing else: the spec's `init` describes a fresh contract, and step 0
        // of every trace asserts that this is where the implementation starts.
    }

    function apply_(CounterSpec.Action action, CounterSpec.Picks memory picks) external override {
        require(msg.sender == address(this), "self-call only");

        if (action == CounterSpec.Action.Increment) {
            counter.increment(picks.by);
        } else if (action == CounterSpec.Action.Touch) {
            counter.touch(picks.key);
        } else if (action == CounterSpec.Action.Finish) {
            counter.finish();
        } else {
            revert("unhandled action");
        }
    }

    function _project() internal view override returns (CounterSpec.State memory s) {
        s.count = counter.count();
        s.status = CounterSpec.Status(uint8(counter.status()));

        // `seen` and `entries` come off the contract in *insertion* order. The
        // model's set and map have no order at all, so the generator sorted
        // them ascending when it lowered the trace. Sorting here is what makes
        // the two comparable; without it, every trace that inserts out of order
        // reports a divergence that is not one.
        s.seen = _ascending(counter.seen());

        uint256[] memory keys = _ascending(counter.keys());
        s.entries = new CounterSpec.EntriesEntry[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            s.entries[i] = CounterSpec.EntriesEntry({
                key: keys[i], hits: counter.hits(keys[i]), flagged: counter.flagged(keys[i])
            });
        }
    }

    /// Insertion sort. The arrays here are bounded by the spec's own domains
    /// (10 increments, 4 keys), so anything cleverer would be noise.
    function _ascending(uint256[] memory a) private pure returns (uint256[] memory) {
        for (uint256 i = 1; i < a.length; i++) {
            uint256 v = a[i];
            uint256 j = i;
            while (j > 0 && a[j - 1] > v) {
                a[j] = a[j - 1];
                j--;
            }
            a[j] = v;
        }
        return a;
    }
}
