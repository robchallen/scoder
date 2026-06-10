---
target-version: 2.1.0
status: draft
tags: [feature, apparmor, ubuntu]
---

# AppArmor Compatibility

## Summary

Ubuntu 24.04+ restricts unprivileged user namespaces via
`kernel.apparmor_restrict_unprivileged_userns=1`. scoder provides
`sudo scoder --configure-apparmor` to install a minimal AppArmor profile
granting `userns` permission to bwrap.

## Motivation

Without this profile, bubblewrap fails on Ubuntu 24.04+ with opaque
permission errors. The `--configure-apparmor` flag and early diagnostic
make this a one-step fix.

## Implementation

[IMPLEMENTED_BY](/src/cli/apparmor.ts#configureAppArmor)

- Installs profile at `/etc/apparmor.d/bwrap`
- Grants `userns` permission only, all other access unconfined
- `checkBwrapUserns()` runs before main logic, provides specific advice on failure

[HAS_FEATURE](./sandbox-isolation.md)

[HAS_TEST](../test-scripts/validation-suite.md)
