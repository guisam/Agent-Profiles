# PowerShell selector forwarding

Investigation #106 reproduced model-selector loss before npm JavaScript or AP
on PowerShell Core 7.6.9 / npm 11.19.0 / Node 24.20.0. A wrapper invoking
`npx ... @args` through npx.ps1 lost forwarded arguments; `npx.cmd ... @args`
and named-array splatting preserved them. Direct literal invocation also worked.

See the [minimal reproduction and tested wrapper](https://github.com/guisam/Agent-Profiles/blob/main/docs/powershell-selector-forwarding.md)
in [PR #108](https://github.com/guisam/Agent-Profiles/pull/108), proposed documentation
patch 0.23.3. Other shim versions are unverified. Windows PowerShell 5.1 was
blocked by execution policy, which was not bypassed.

A complete end marker does not prove correct selection: the affected wrapper
returned baseline 1.0.0 with a complete marker. Verify model, role, selected rule,
version and digest. No AP runtime, global shim or execution-policy change was made.
No YAML, lock, store or bootstrap migration is required. npm was not published.

## Scope caveat

The reproduced case is automatic `@args` forwarding from a PowerShell wrapper
through the tested npm 11.19.0 shim on PowerShell 7.6.9. Literal invocation and
a named-array wrapper preserved arguments in these tests. This is not a claim
about every npx invocation, npm v7–v11, or Windows PowerShell 5.1.
[npm PR #8278](https://github.com/npm/cli/pull/8278) introduced reconstruction;
the npm 10.9.0 source used direct forwarding. The affected release range and
availability of an upstream fix have not been established. Further upstream
research does not block the next AP evaluation task.
