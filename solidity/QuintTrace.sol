// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { Vm } from "forge-std/Vm.sol";

/// Loading for the fixtures `quint-sol-connect gen` writes.
///
/// A fixture is `{"meta": {...}, "steps": "0x..."}`. The steps are ABI-encoded
/// offline rather than left as JSON, so the only JSON paths in the whole system
/// are the fixed `meta` keys read below. Nothing parses the trace body: it is
/// one `abi.decode` against the generated `Step[]` type.
///
/// The verbatim ITF trace is committed next to every fixture and named by
/// `meta.itf`, so the readable original is always one file away.
library QuintTrace {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    struct Meta {
        string spec;
        string quintVersion;
        string toolVersion;
        string seed;
        string itf;
        string testName;
        uint256 traceIndex;
        uint256 steps;
        bytes32 schemaHash;
    }

    /// Read a fixture and hand back its metadata plus the undecoded step blob.
    ///
    /// `expectedSchemaHash` is the generated library's `SCHEMA_HASH`. Checking
    /// it *before* decoding turns a config change that was not followed by a
    /// regeneration into a named failure, rather than into an `abi.decode` that
    /// either reverts opaquely or, worse, succeeds and compares nonsense.
    function load(string memory path, bytes32 expectedSchemaHash)
        internal
        view
        returns (Meta memory meta, bytes memory steps)
    {
        string memory json = VM.readFile(path);

        meta.spec = VM.parseJsonString(json, ".meta.spec");
        meta.quintVersion = VM.parseJsonString(json, ".meta.quintVersion");
        meta.toolVersion = VM.parseJsonString(json, ".meta.toolVersion");
        meta.seed = VM.parseJsonString(json, ".meta.seed");
        meta.itf = VM.parseJsonString(json, ".meta.itf");
        meta.testName = VM.parseJsonString(json, ".meta.testName");
        meta.traceIndex = VM.parseJsonUint(json, ".meta.traceIndex");
        meta.steps = VM.parseJsonUint(json, ".meta.steps");
        meta.schemaHash = bytes32(VM.parseJsonUint(json, ".meta.schemaHash"));

        require(
            meta.schemaHash == expectedSchemaHash,
            string.concat(
                "quint-sol-connect: trace schema drift in ",
                path,
                " - the fixture was generated for a different state/action shape. Run `quint-sol-connect gen`."
            )
        );

        steps = VM.parseJsonBytes(json, ".steps");
    }
}
