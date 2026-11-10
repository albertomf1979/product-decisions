---
name: status
description: Show what product-decisions has captured in this repository, and whether capture is active. Runs the CLI and changes nothing.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/src/cli/index.js" status)
---

!`node "${CLAUDE_PLUGIN_ROOT}/src/cli/index.js" status`

Show the output above to the person as it is. Run nothing else.
