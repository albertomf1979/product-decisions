---
name: verify
description: Check that this repository's product-decisions record has not been altered. Runs the CLI and changes nothing.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/src/cli/index.js" verify)
---

!`node "${CLAUDE_PLUGIN_ROOT}/src/cli/index.js" verify`

Show the output above to the person as it is. Run nothing else.
