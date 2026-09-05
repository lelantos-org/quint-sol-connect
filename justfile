set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

[doc('Install the JS toolchain, including the pinned quint')]
install:
    npm ci

[doc('Everything CI runs')]
ci: unit check gen-is-noop example generic

[doc('Unit tests for the ITF decoder and the ABI lowering')]
unit:
    npm test

[doc('Typecheck the example spec and run its Quint tests')]
spec:
    ./node_modules/.bin/quint typecheck examples/counter/spec/counter.qnt

[doc('Regenerate fixtures and Solidity for the example')]
gen *args:
    node bin/quint-connect-sol.mjs gen {{ args }}

[doc('Fail if committed fixtures drifted from the config')]
check:
    node bin/quint-connect-sol.mjs check

# Regeneration must be byte-identical for an unchanged spec: that is what lets a
# consumer gate CI on `gen && git diff --exit-code`. If this fails, something in
# the pipeline is not deterministic.
[doc('Prove regeneration is a no-op on an unchanged spec')]
gen-is-noop: gen
    git diff --exit-code -- examples/counter/fixtures examples/counter/test/generated

[doc('Replay the example traces')]
example *args:
    forge test {{ args }}

# The package must stay free of anything specific to its first consumer. A
# separate repo makes that easy to hold; this makes it checkable.
#
# `lelantos` is deliberately not on this list: it is the npm scope, so it
# legitimately appears in the generated-file header. What must never appear is a
# domain term from a consumer's protocol.
[doc('Fail if consumer-specific names leaked into the tool')]
generic:
    @if git grep -In -i -e masp -e shielded -e nullifier -e groth16 \
        -- src bin solidity examples; then \
        echo "consumer-specific names leaked into the tool"; exit 1; \
    fi

[doc('Format Solidity')]
fmt:
    forge fmt

[doc('Check Solidity formatting')]
fmt-check:
    forge fmt --check
