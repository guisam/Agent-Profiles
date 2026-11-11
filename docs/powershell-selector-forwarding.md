# PowerShell wrappers: verify selector forwarding

## Finding from #106

On Windows, a wrapper calling `npx ... @args` lost its forwarded selectors
before npm's JavaScript entry point ran. Agent Profiles then correctly treated
the model as unstated and selected the configured baseline. This reproduced the
symptom reported in [#105](https://github.com/guisam/Agent-Profiles/issues/105#issuecomment-6781389034)
without a model run. It is not an AP resolver parsing defect.

Tested November 10, 2026: PowerShell Core 7.6.9, Node 24.20.0, npm 11.19.0,
Windows build 26300. `Get-Command npx -All` selected `npx.ps1` before `npx.cmd`.
The installed shim's SHA256 was
`0341d1d2ec7818edf7c5affb6446a952f9a28a98689910f89a51c5a6c3a78ad9`.
Other npm/shim versions are not established by this result. Windows PowerShell
5.1 refused scripts under the existing execution policy; it was not bypassed.

## Reproduction without AP or package downloads

In a disposable directory, create `capture.cjs`:

```javascript
if (process.argv[1]?.endsWith('npx-cli.js')) {
  console.log(JSON.stringify(process.argv.slice(2)));
  process.exit(0);
}
```

Create `forward.ps1`:

```powershell
& npx --offline --no argv-probe @args
exit $LASTEXITCODE
```

In a fresh PowerShell window, from that directory:

```powershell
$env:NODE_OPTIONS = '--require=' + (Join-Path (Get-Location) 'capture.cjs')
pwsh -NoProfile -File ./forward.ps1 --host claude --identity-source host-stated --model claude-sonnet-5-5 --role reviewer
Remove-Item Env:NODE_OPTIONS
```

Use a directory without spaces for this minimal probe. The preload prints argv
and exits before npm parses the command or executes `argv-probe`; no such
package needs to exist or be installed. The affected wrapper printed only:

```json
["--offline","--no","argv-probe"]
```

Repeating with `npx.cmd` in the wrapper preserved all eight forwarded arguments.
Keeping `npx` but copying `$args` into `$forwarded` and splatting `@forwarded`
also preserved them. Direct literal invocation preserved them as well. Three
assertions checked the affected, cmd and named-array wrapper outputs exactly.

Inspection of this installed `npx.ps1` shows that, when invocation-line metadata
exists, it parses the caller's source text and re-executes the reconstructed
command with `Invoke-Expression`. The automatic `@args` token is evaluated in
the shim's context. This explains the observed difference from a named variable
and `npx.cmd`; the argv capture localizes the loss before npm's JavaScript and AP.
The exact historical failed draft was not retained; this is a fresh minimal
reproduction of the same invocation form.

## Tested wrapper form

For a Windows wrapper that forwards AP selectors, the tested form is:

```powershell
& npx.cmd --no agent-profiles resolve @args
exit $LASTEXITCODE
```

Preserve the intended working directory and any explicitly approved isolated
store/trust/session environment. A launcher change does not establish isolation
by itself. Do not edit managed bootstrap blocks casually: a fixture customization
is reported as modified by `doctor`, and is not a stock bootstrap migration.
This guidance does not bypass denied setup commands or change execution policy.

## AP selection checks

Using the isolated #105 fixture (AP source 0.23.1), all tested calls exited 0:

| Invocation | Model observed by AP | Selected version |
| --- | --- | --- |
| `npx` wrapper with `@args`, Sonnet requested | not stated | baseline 1.0.0 |
| `npx` wrapper with `@args`, Opus requested | not stated | baseline 1.0.0 |
| `npx.cmd` wrapper, Sonnet requested | claude-sonnet-5-5 | 2.0.0 |
| `npx.cmd` wrapper, Opus requested | claude-opus-5-5 | 3.0.0 |
| `npx.cmd` wrapper, unknown model | unknown-model | baseline 1.0.0 |
| `npx.cmd` wrapper, model omitted | not stated | baseline 1.0.0 |

The affected wrapper also lost an explicitly unknown model. Every output had a
complete five-section end marker. Thus completeness is separate from selection:
check model identity, role, selected assignment and package version/digest too.
No AP runtime change or global shim edit was needed. Future shim behavior should
be checked with the probe instead of assuming these results apply universally.

## Exact scope and upstream history

This finding concerns a PowerShell script forwarding its automatic `@args`
through the tested `npx.ps1` launcher. It does not establish that ordinary literal
npx commands, all npm versions, or all PowerShell versions lose arguments.
Windows PowerShell 5.1 remains unverified here.

The reconstruction change was introduced by
[npm PR #8278](https://github.com/npm/cli/pull/8278), merged May 12, 2025,
[commit 2210d7a](https://github.com/npm/cli/commit/2210d7a), to address specific
flag and quoting behavior. The
[npm 10.9.0 launcher](https://github.com/npm/cli/blob/v10.9.0/bin/npx.ps1)
uses direct argument forwarding rather than that reconstruction path. Do not
infer an affected npm v7–v11 range from the presence of a PowerShell shim.
No claim is made here that every current release is affected or that no upstream
fix exists. Upstream historical research is optional follow-up, not a blocker
for using the tested fixture workaround and continuing AP evaluation work.
