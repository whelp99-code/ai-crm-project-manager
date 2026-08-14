# Customer Work OS v1.0.0 Stabilization Baseline

- Source commit: `36a2afe6ac0bcf756af602494fda75c22728bc32`
- Purpose: freeze feature development and run deterministic hardening on an isolated branch.
- Allowed workflows: `ci.yml`, `customer-work-os.yml`, `customer-work-os-release-gate.yml`.
- Temporary self-mutating one-shot workflows are forbidden.
- Release is blocked until the declared verification matrix has zero open findings.
