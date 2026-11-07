# Ponytail role preset

The [portable example](https://github.com/guisam/Agent-Profiles/tree/main/examples/presets/ponytail)
shows how to use four Ponytail instruction skills through AP without its plugin:
implementation, review, audit and shortcut debt. The README explains every role,
the shared base profile, `agents.yaml`, import and model-specific package pins.

The example is self-contained and retains Ponytail's MIT license and provenance.
No private packages, machine paths or signing approvals are included. Import
copies instructions; library updates are a separate, explicit adoption workflow.

Live testing demonstrated one project adopting a new skill while another stayed
pinned, followed by adoption of the same digest. Recovery tests led to #80;
delivery is not proof of instruction adherence. Subagent and failure coverage
remain tracked by #82 and #83. Model-specific optimization is a future evaluation
goal, not a measured result of this preset.

## Upgrade

Added in 0.19.5. Existing users need no migration or bootstrap regeneration for
this example-only change. Inspect the preset, import selected roles into an
initialized project, and review conflict/default choices. Preserve project rules.
