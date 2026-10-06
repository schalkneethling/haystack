# Repository controls

Calavera generated a committed desired-state policy for `schalkneethling/haystack`.

Run the read-only drift check before applying any remote changes:

```sh
node scripts/repository-controls.mjs
```

Review the reported plan, then apply it interactively:

```sh
node scripts/repository-controls.mjs --apply
```

For intentional unattended administration, add `--yes` to the apply command.

## CodeQL merge protection

The generated policy uses the extended query suite and requires CodeQL results, blocking errors and warnings plus medium-or-higher security alerts. Edit `mainRuleset.codeScanning` in the committed policy to choose thresholds; set it to null to leave scanning rules unmanaged (existing remote rules are retained). Older policies without this field leave scanning rules unmanaged. Re-applying the Calavera recipe regenerates the policy.

Checks verify active branch enforcement, default-branch scope without exclusions, and an explicitly empty bypass list. Applying repairs these shared protections and preserves unrelated rules and other scanners. Review the plan before applying.

GitHub must support code-scanning merge protection for the repository. A required scan must have results for both the commit and target reference. See [GitHub rules documentation](https://docs.github.com/en/rest/repos/rules).

## Manual controls

- In **Settings → Advanced Security**, enable Dependabot malware alerts.
  The generated script verifies the repository identity before planning or applying changes. Unsupported GitHub plan features are reported separately from drift.
