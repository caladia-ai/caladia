# Vendored dependencies

## `xlsx-0.20.3.tgz`

The SheetJS Community Edition (`xlsx`), downloaded from
<https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz>.

**Why vendored:** SheetJS pulled `xlsx` from npm at 0.18.5. The npm version
is abandoned and carries two unpatched CVEs (prototype pollution
CVE-2023-30533 and ReDoS CVE-2024-22363). Versions ≥0.20.2 fix both, but
SheetJS publishes those only via their own CDN, not npm. We pin the tarball
inside the repo and reference it from `packages/importers/package.json` via
the `file:` protocol so `pnpm install` works in a clean clone without any
network round-trip beyond the standard registry.

**License:** Apache-2.0 (same as the historic npm package). The tarball
contains the upstream `LICENSE` file unchanged.

**SHA-256:** `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`
(see `xlsx-0.20.3.tgz.sha256`). Verify after any future swap with:

```bash
shasum -a 256 -c packages/importers/vendor/xlsx-0.20.3.tgz.sha256
```

**Updating:** When a new SheetJS release is out, download the new tarball
from `https://cdn.sheetjs.com/xlsx-<version>/xlsx-<version>.tgz`, replace
this file, update the `.sha256` companion, bump the `file:` path in
`packages/importers/package.json`, run `pnpm install`, and run the full
test suite. Don't pull a tarball less than 7 days old per the global
package-installation policy.
