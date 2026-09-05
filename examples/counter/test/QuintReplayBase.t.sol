// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";

import { QuintReplayBase } from "quint-sol-connect/QuintReplayBase.sol";

/// Exposes the internal decoder. The base is abstract, so a test subclass
/// supplies the two members a real driver would.
contract RevertDecoderHarness is QuintReplayBase {
    function decode(bytes memory ret) external pure returns (string memory) {
        return _revertMessage(ret);
    }
}

error CustomWithString(string reason);

/// The revert decoder is the difference between a readable failure and 130
/// characters of hex, and it is the one piece of the failure report with real
/// branching. Tested directly rather than only through a divergence.
contract QuintReplayBaseTest is Test {
    RevertDecoderHarness internal h;

    function setUp() public {
        h = new RevertDecoderHarness();
    }

    function test_decodesRequireString() public view {
        bytes memory data = abi.encodeWithSignature("Error(string)", "something went wrong");
        assertEq(h.decode(data), "something went wrong");
    }

    /// The case that matters most: forge raises a single-string custom error
    /// when an `expectRevert` does not fire, which is how a negative model
    /// action reports that the implementation failed to reject.
    function test_decodesCustomErrorCarryingOneString() public view {
        bytes memory data = abi.encodeWithSelector(CustomWithString.selector, "next call did not revert as expected");
        assertEq(h.decode(data), "next call did not revert as expected");
    }

    function test_namesPanics() public view {
        bytes memory data = abi.encodeWithSignature("Panic(uint256)", uint256(0x11));
        assertEq(h.decode(data), "Panic(17)");
    }

    /// Anything it cannot read comes back empty, so the caller prints raw bytes
    /// instead of inventing a message.
    function test_returnsEmptyForUndecodableData() public view {
        assertEq(h.decode(hex""), "");
        assertEq(h.decode(hex"1578538d"), ""); // bare custom-error selector
        assertEq(h.decode(abi.encodeWithSignature("Two(uint256,uint256)", 1, 2)), "");
    }
}
