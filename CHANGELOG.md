# Changelog

All notable changes to Taste Profile are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.7.0] - 2026-10-30

### Fixed

- A Spotify request that never returns now stops at the 20-second load budget, and Refresh stays available
- A failed refresh keeps the playlists and tracks already on screen
- Excluded-track titles are no longer taken from a different song when decoration results are misaligned
- Tracks whose details failed to load are labeled separately from tracks Spotify reports as unavailable
- Another exclusion change waits until the current update finishes

### Changed

- Playlists and Tracks share one page. The tab only switches the table; summary, filter, search, sort, and Compact / List stay in place
- Long playlist and track lists render a window of rows while scrolling
- About copy uses the Compact and List view names

## [1.6.1] - 2026-10-27

### Changed

- App, Marketplace, and README descriptions rewritten to emphasize taking control of taste-profile exclusions (playlists and tracks, individually or in bulk)
- In-app header subtitle, About panel, and Playlists / Excluded Tracks section copy aligned with the new positioning

## [1.6.0] - 2026-10-27

Public Marketplace release covering everything since [1.3.0] (including unpublished monorepo bumps 1.4.0 and 1.5.0).

### Added

- **Excluded Tracks** tab alongside Playlists — manage track exclusions from one place
- Playlist and track **sorting** (library order, name, track count, recently excluded; tracks also by artist or album)
- Playlist **View as** Compact (dense, no artwork) or List (artwork + metadata); preference is remembered
- App **version** shown in the header (`src/version.ts` generated from `package.json` on build)
- **Brand kit** assets under `assets/Taste_Profile_Brand_Kit/` plus refreshed logos, app icon, and product screenshot
- Load **retry budget** (20s) so slow Spotify collection responses recover instead of hanging forever
- Keyboard navigation for the Playlists / Excluded Tracks tab list
- Confirmation prompts for large bulk exclude / remove-exclusion batches
- Refresh control with progress and relative last-updated time
- `sync-release` scripts (PowerShell + shell) to mirror this package into the public Marketplace repo
- `write-version.mjs` prebuild hook to keep the in-app version in sync

### Changed

- Filters simplified to **All** / **Excluded** / **Not excluded** (library-only playlist listing)
- Wording aligned with Spotify: **Remove exclusion** instead of “Include”
- UI styling closer to Spotify library patterns (scoped under `.taste`, prefers `--spice-*` tokens)
- Notifications and open-playlist / open-track error handling made clearer
- README rewritten for tracks, sorting, Compact/List view, installers, and publish flow
- Marketplace `manifest.json` description and tags updated for playlists + tracks

### Removed

- “Not in library” playlist filter (excluded tracks cover non-library exclusions; playlists require library membership)
- Outdated design documentation and unused design images from the package tree

## [1.5.0] - 2026-10-27

Monorepo version bump (not published alone). Folded into [1.6.0].

### Added

- Excluded Tracks view and track exclusion management
- Sorting for playlists and tracks

### Changed

- App description and README to cover tracks as well as playlists

## [1.4.0] - 2026-10-27

Monorepo version bump (not published alone). Folded into [1.6.0].

### Added

- In-app version badge in the header
- `sync-release` helpers and Marketplace publish notes in the README
- `scripts/write-version.mjs` to regenerate `src/version.ts` from `package.json`

## [1.3.0] - 2026-10-26

Spicetify Creator custom app release for Marketplace (`spicetify-apps`).

### Changed

- Flat Creator package layout (root `src/`, `dist/`, `manifest.json`) for Marketplace install scripts
- Installers and README paths updated for the public `GZHN/taste-profile` repo

## [1.1.0] - 2026-10-26

### Added

- One-command installers for Windows (PowerShell) and macOS/Linux

### Changed

- Repo layout: app under `app/`, logos and screenshots under `assets/`
- README install instructions for the new layout

## [1.0.0] - 2026-10-21

First release — list playlists excluded from your Spotify taste profile and change that setting from one place.

### Added

- Filters: All, Excluded, Included, Not in library
- Search by playlist name, folder, or owner
- Exclude / include a playlist, a selection, or everything in the current view
- Undo the last change

[1.7.0]: https://github.com/GZHN/taste-profile/releases/tag/v1.7.0
[1.6.1]: https://github.com/GZHN/taste-profile/releases/tag/v1.6.1
[1.6.0]: https://github.com/GZHN/taste-profile/releases/tag/v1.6.0
[1.5.0]: https://github.com/GZHN/taste-profile/releases/tag/v1.6.0
[1.4.0]: https://github.com/GZHN/taste-profile/releases/tag/v1.6.0
[1.3.0]: https://github.com/GZHN/taste-profile/releases/tag/v1.3.0
[1.1.0]: https://github.com/GZHN/taste-profile/releases/tag/v1.1.0
[1.0.0]: https://github.com/GZHN/taste-profile/releases/tag/v1.0.0
