// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { console2 } from "forge-std/console2.sol";

import { QuintTrace } from "./QuintTrace.sol";

/// Spec-agnostic half of a Quint replay: fixture bookkeeping, the field-diff
/// accumulator, and the failure report. The generated `<Spec>SpecReplay`
/// supplies everything that depends on the spec's own types.
///
/// Comparators accumulate instead of asserting so that one step reports *every*
/// diverging field at once. Finding out that four fields moved together is a
/// different diagnosis from finding out that one did, and stopping at the first
/// mismatch hides that.
abstract contract QuintReplayBase is Test {
    /// 0 = quiet, 1 = one line per step, 2 = every field compared.
    /// Mirrors upstream quint-connect's QUINT_VERBOSE.
    uint256 internal quintVerbose;

    QuintTrace.Meta internal _meta;
    string internal _tracePath;
    uint256 internal _stepIndex;
    uint256 internal _mismatches;

    /// Set once a divergence has been reported. `fail()` marks the test failed
    /// but does not stop execution, and every step after the first divergence
    /// compares state the implementation was never going to reach, so the
    /// replay loop stops here instead of printing the same report N more times.
    bool internal _diverged;

    /// Set once `_requireStateCarriesAcrossCalls` has run, so the probe costs
    /// one call per test rather than one per step.
    bool private _isolateChecked;
    uint256 private _isolateProbe;

    function _beginTrace(string memory path, QuintTrace.Meta memory meta) internal {
        quintVerbose = vm.envOr("QUINT_VERBOSE", uint256(0));
        _tracePath = path;
        _meta = meta;
        _stepIndex = 0;
        _mismatches = 0;
        _diverged = false;
    }

    // --- field comparators ------------------------------------------------
    // Each returns 1 on mismatch so the caller can sum them.

    function _eqU(string memory field, uint256 model, uint256 chain) internal returns (uint256) {
        if (model == chain) {
            if (quintVerbose >= 2) console2.log("        %s = %s", field, vm.toString(model));
            return 0;
        }
        console2.log("      %s: model=%s chain=%s", field, vm.toString(model), vm.toString(chain));
        return 1;
    }

    function _eqI(string memory field, int256 model, int256 chain) internal returns (uint256) {
        if (model == chain) {
            if (quintVerbose >= 2) console2.log("        %s = %s", field, vm.toString(model));
            return 0;
        }
        console2.log("      %s: model=%s chain=%s", field, vm.toString(model), vm.toString(chain));
        return 1;
    }

    function _eqB(string memory field, bool model, bool chain) internal returns (uint256) {
        if (model == chain) {
            if (quintVerbose >= 2) console2.log("        %s = %s", field, vm.toString(model));
            return 0;
        }
        console2.log("      %s: model=%s chain=%s", field, vm.toString(model), vm.toString(chain));
        return 1;
    }

    function _eqA(string memory field, address model, address chain) internal returns (uint256) {
        if (model == chain) {
            if (quintVerbose >= 2) console2.log("        %s = %s", field, vm.toString(model));
            return 0;
        }
        console2.log("      %s: model=%s chain=%s", field, vm.toString(model), vm.toString(chain));
        return 1;
    }

    function _eqBytes32(string memory field, bytes32 model, bytes32 chain) internal returns (uint256) {
        if (model == chain) {
            if (quintVerbose >= 2) console2.log("        %s = %s", field, vm.toString(model));
            return 0;
        }
        console2.log("      %s: model=%s chain=%s", field, vm.toString(model), vm.toString(chain));
        return 1;
    }

    /// Also used for enums, which are compared by *name* so a report reads
    /// `status: model=Flushed chain=Pending` rather than `2` versus `0`.
    function _eqStr(string memory field, string memory model, string memory chain) internal returns (uint256) {
        if (keccak256(bytes(model)) == keccak256(bytes(chain))) {
            if (quintVerbose >= 2) console2.log("        %s = %s", field, model);
            return 0;
        }
        console2.log("      %s: model=%s chain=%s", field, model, chain);
        return 1;
    }

    /// `name[i]` without string concatenation at every call site.
    function _idx(string memory name, uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(name, "[", vm.toString(i), "].", field);
    }

    // --- reporting --------------------------------------------------------

    function _reportIfDiverged(string memory action) internal {
        if (_mismatches == 0) return;
        _diverged = true;
        console2.log("");
        console2.log("  MODEL / IMPLEMENTATION DIVERGENCE");
        console2.log("    spec   : %s", _meta.spec);
        console2.log("    trace  : %s", _tracePath);
        console2.log("    itf    : %s", _meta.itf);
        console2.log("    step   : %s of %s", vm.toString(_stepIndex), vm.toString(_meta.steps));
        console2.log("    action : %s", action);
        console2.log("    fields : %s diverged (listed above)", vm.toString(_mismatches));
        console2.log("");
        console2.log("  reproduce:");
        console2.log("    QUINT_VERBOSE=2 forge test --match-test %s -vvv", _meta.testName);
        fail();
    }

    /// The model said this action was enabled here. If the implementation
    /// reverts, that is a divergence in its own right, and a different one from
    /// a state mismatch: the model is usually missing a guard the contract has.
    /// Reported under its own heading so triage starts from the right question.
    function _dispatch(bytes memory callData, string memory action) internal {
        _requireStateCarriesAcrossCalls();
        (bool ok, bytes memory ret) = address(this).call(callData);
        if (ok) return;
        _diverged = true;
        console2.log("");
        console2.log("  ENABLEDNESS DIVERGENCE");
        console2.log("    the model enabled `%s` at step %s; the implementation reverted", action, vm.toString(_stepIndex));
        console2.log("    revert : %s", vm.toString(ret));
        if (ret.length == 0) {
            console2.log("    (empty revert data: out of gas, an assert, or a bare `revert()`)");
        }
        console2.log("    spec   : %s", _meta.spec);
        console2.log("    trace  : %s", _tracePath);
        console2.log("    itf    : %s", _meta.itf);
        console2.log("");
        console2.log("  This is usually the model missing a guard the implementation has.");
        console2.log("  reproduce:");
        console2.log("    QUINT_VERBOSE=2 forge test --match-test %s -vvvv", _meta.testName);
        fail();
    }

    /// Dispatch goes through an external self-call so a revert can be caught
    /// and named. That only preserves state if Foundry is not running each
    /// top-level call in its own context. Under `isolate = true` every step
    /// would silently start from a fresh EVM and the first state comparison
    /// would fail for a reason having nothing to do with the model, so the
    /// condition is checked once, up front, and reported in those terms.
    function _requireStateCarriesAcrossCalls() private {
        if (_isolateChecked) return;
        _isolateChecked = true;
        uint256 sentinel = _isolateProbe + 1;
        (bool ok,) = address(this).call(abi.encodeCall(this.quintIsolateProbe, (sentinel)));
        require(ok, "quint-sol-connect: isolate probe call failed");
        require(
            _isolateProbe == sentinel,
            "quint-sol-connect: replay requires `isolate = false` in foundry.toml - "
            "with isolation on, each step runs in a fresh EVM context and no state carries between them"
        );
    }

    function quintIsolateProbe(uint256 v) external {
        require(msg.sender == address(this), "quint-sol-connect: self-call only");
        _isolateProbe = v;
    }
}
