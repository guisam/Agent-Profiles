---
title: Visualizer refresh is manual by user choice
author: Codex
date: 2026-11-12
branch: main
touches:
  - src/visualizer/app.js test/visualizer-live.test.js
---

## Decided
The user clarified that a working Refresh files button solves the problem; automatic updates are no longer required. Version 0.24.1 removes browser polling, debounce state, connection retry scheduling and page lifecycle timers while retaining the composed project/adapter endpoints, host selector, state reconciliation and trust error handling. File changes and repairs appear when Refresh files is clicked; selector changes still resolve on demand.
## Tried and ruled out
Keeping polling as a hidden default or adding a toggle would retain complexity the user does not need. Do not revert the adapter composition and host changes: the old button reread a disposable snapshot, which was the actual defect. The earlier polling learning describes the superseded 0.24.0 requirement, not current behavior.
## Watch out
Tests must exercise the Refresh files click handler with changed adapter/project files, stale locks, malformed configuration and approvals, and verify that initial load and refresh schedule no timers. Preserve valid optional selections. Full-suite verification should use the disposable clean validation checkout and a process-local isolated trust path to avoid the machine-policy mismatches documented in the implementation report; never change live trust or signing settings.
