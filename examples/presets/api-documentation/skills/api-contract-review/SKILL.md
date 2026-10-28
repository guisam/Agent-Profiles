---
name: api-contract-review
description: Review reconciled API references and migration guides for contract coverage and cross-document consistency.
---

# API contract review

Audit every requested operation and source issue against the complete deliverable
set. Preserve declared types, constraints, security requirements, status codes and
response formats. Separate proposed conventions from the current service contract.

For each migration claim, identify its comparison basis: legacy contract, current
documentation, current schema or observed behavior. Check documented alternatives
before calling a capability removed. Identify observations that require engineering
confirmation without inventing missing behavior, SDK versions or metrics.

Check that examples, reference sections, migration steps and impact rows agree.
Validate machine-readable outputs with parsers. Conclude with evidence-backed
findings, remaining questions and checks actually performed.
