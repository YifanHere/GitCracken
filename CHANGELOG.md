# v9.0.0 - GitKraken 12 support :tada:

- Support GitKraken 10.x – 12.x (tested on 12.5.0) with the new `v12` feature
  (alias: `advanced`)
  - Patches `getLicensedFeatures` in the three shipped webpack bundles
    (`main`, `render`, `requestHandler`)
  - In-place, same-length ASAR edit: no unpack/pack, no duplicated
    `app.asar.unpacked` content, archive size stays unchanged
  - Works while signed out; the old `pro` patch only ran on phone-home and was
    reset by the logout branch
- New `--check` flag to report the current patch state
- New `revert` action to restore `app.asar.bak-before-gitcracken`
- New `--no-backup` flag; v12 backups are created once instead of per run
- Auto mode now detects the installed GitKraken version and selects
  `v12` (10+) or the legacy `pro` workflow (≤ 9.x)
- Author list now includes **Yifan**

# v8.4.0

- Last release of the original maintenance line (GitKraken ≤ 9.x)

# v0.6.2 - Patches with Love :cupid:

- Support GitKraken v6.5.2
  - Pro
  - Individual
  - Enterprise
    - Self-Hosted
    - Stand-Alone
  - Modes
    - Development
    - Staging
- Bump dependencies

> Our greatest glory is not in never falling, but in getting up every time we do.

# v0.6.1 - Return of the missing patches

- Support GitKraken v6.0.0
  - Pro
  - Individual
  - Enterprise
    - Self-Hosted
    - Stand-Alone
  - Modes
    - Development
    - Staging
- Bump dependencies

# v0.6.0 - Lightspeed :rocket:

- Support GitKraken Pro v6.0.0
- Bump dependencies
