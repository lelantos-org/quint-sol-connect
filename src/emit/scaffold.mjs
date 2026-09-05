/**
 * One-shot driver stub.
 *
 * Written once and never overwritten: the driver is the one file a human owns,
 * and the whole point of the split is that regeneration cannot touch it. The
 * stub reverts rather than returning defaults, so an unfilled branch fails
 * loudly instead of quietly comparing zeros.
 */

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function emitDriverStub(model, runtimeImport) {
  const q = model.qualify;
  const C = model.driver.contract;
  const replay = `${cap(model.name)}SpecReplay`;
  const L = [];

  L.push('// SPDX-License-Identifier: Apache-2.0');
  L.push(`pragma solidity ${model.pragma};`);
  L.push('');
  L.push(`import { ${model.lib} } from "${model.solidityOut}/${model.lib}.sol";`);
  L.push(`import { ${replay} } from "${model.solidityOut}/${replay}.sol";`);
  L.push('');
  L.push(`/// Driver for ${model.specPath}.`);
  L.push('///');
  L.push('/// Generated once by \`quint-connect-sol scaffold\`; owned by you from here on.');
  L.push('/// `abstract` so Foundry does not collect it as a test contract - the generated');
  L.push(`/// \`${cap(model.name)}Traces\` inherits it and holds the per-trace tests.`);
  L.push(`abstract contract ${C} is ${replay} {`);
  L.push('    function setUp() public virtual {');
  L.push('        // Deploy the implementation and leave it in the state the spec\'s `init`');
  L.push('        // describes. Step 0 of every trace asserts exactly that.');
  L.push('        revert("TODO: deploy the system under test");');
  L.push('    }');
  L.push('');
  L.push(`    function apply_(${model.lib}.Action action, ${model.lib}.Picks memory picks) external override {`);
  L.push('        require(msg.sender == address(this), "self-call only");');
  L.push('');
  model.actions.forEach((a, i) => {
    const kw = i === 0 ? 'if' : '} else if';
    L.push(`        ${kw} (action == ${model.lib}.Action.${a.enumName}) {`);
    const args = a.picks.map((p) => `picks.${p}`).join(', ');
    L.push(`            revert("TODO: ${a.name}(${args || ''})");`);
  });
  if (model.actions.length > 0) L.push('        }');
  L.push('    }');
  L.push('');
  L.push('    /// Read live state into the model\'s shape.');
  L.push('    ///');
  L.push('    /// Prefer a real on-chain read for every field. Where the implementation');
  L.push('    /// genuinely cannot expose one, shadow it in the driver - and cross-check');
  L.push('    /// that shadow against the nearest observable with a `require`, so a driver');
  L.push('    /// bug fails as a driver bug instead of looking like a model divergence.');
  L.push(`    function _project() internal view override returns (${model.lib}.State memory s) {`);
  for (const s of model.state) {
    L.push(`        // s.${s.name} = ...; // ${q(s.node)}`);
  }
  L.push('        revert("TODO: project implementation state");');
  L.push('    }');
  L.push('}');
  return L.join('\n') + '\n';
}
