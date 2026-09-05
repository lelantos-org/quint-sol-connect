// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// The system under test for `examples/counter/spec/counter.qnt`.
///
/// Deliberately shaped so the example exercises every lowering the tool
/// supports: a plain integer, an enum, a set, and a map to a record. It also
/// keeps its collections in *insertion* order, which the model does not have,
/// so the driver has to impose the canonical order the comparison needs. That
/// is the normal situation, not a quirk of this example.
contract Counter {
    enum Status {
        Idle,
        Running,
        Done
    }

    uint256 public constant LIMIT = 100;

    uint256 public count;
    Status public status;

    uint256[] private _seen;
    mapping(uint256 value => bool) public seenHas;

    uint256[] private _keys;
    mapping(uint256 key => uint256) public hits;
    mapping(uint256 key => bool) public flagged;

    error Finished();
    error LimitExceeded();
    error NotRunning();

    function increment(uint256 by) external {
        if (status == Status.Done) revert Finished();
        if (count + by > LIMIT) revert LimitExceeded();
        count += by;
        status = Status.Running;
        if (!seenHas[by]) {
            seenHas[by] = true;
            _seen.push(by);
        }
    }

    function touch(uint256 key) external {
        if (status == Status.Done) revert Finished();
        if (hits[key] == 0) _keys.push(key);
        hits[key] += 1;
        flagged[key] = hits[key] >= 2;
        status = Status.Running;
    }

    function finish() external {
        if (status != Status.Running) revert NotRunning();
        status = Status.Done;
    }

    function seen() external view returns (uint256[] memory) {
        return _seen;
    }

    function keys() external view returns (uint256[] memory) {
        return _keys;
    }
}
