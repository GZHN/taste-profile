<a id="readme-top"></a>

<!-- PROJECT SHIELDS -->

[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]

<!-- PROJECT LOGO -->
<br />
<div align="center">
  <a href="https://github.com/GZHN/taste-profile">
    <img src="assets/logo/logo-on-github-dark.svg" alt="Taste Profile" width="420">
  </a>

  <p align="center">
    Take control of your Spotify taste profile. Easily manage playlist and track exclusions, individually or in bulk, directly within Spotify.
    <br />
    <a href="https://support.spotify.com/us/article/exclude-playlists-or-tracks-from-your-taste-profile/"><strong>How Spotify uses your taste profile »</strong></a>
    <br />
    <br />
    <a href="https://github.com/GZHN/taste-profile/issues/new?labels=bug">Report Bug</a>
    &middot;
    <a href="https://github.com/GZHN/taste-profile/issues/new?labels=enhancement">Request Feature</a>
  </p>
</div>

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li><a href="#about-the-project">About The Project</a></li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation</a></li>
        <li><a href="#uninstall">Uninstall</a></li>
      </ul>
    </li>
    <li><a href="#usage">Usage</a></li>
    <li><a href="#changelog">Changelog</a></li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#contact">Contact</a></li>
    <li><a href="#acknowledgments">Acknowledgments</a></li>
  </ol>
</details>

<!-- ABOUT THE PROJECT -->

## About The Project

[![Taste Profile listing excluded playlists][product-screenshot]](https://support.spotify.com/us/article/exclude-playlists-or-tracks-from-your-taste-profile/)

**Taste Profile** is a Spicetify custom app that gives you a centralized way to manage which playlists and tracks are excluded from your Spotify taste profile.

Spotify uses your listening activity to personalize recommendations and experiences such as Discover Weekly, Wrapped, and Blend. Taste Profile makes it easier to control which music contributes to those experiences without navigating through individual playlist menus.

**Key features:**

- **Playlist management:** View and manage taste-profile exclusions across your playlists from one interface.
- **Excluded tracks:** Browse and remove exclusions from individual tracks.
- **Bulk actions:** Exclude or restore multiple playlists at once.
- **Search and filtering:** Quickly find playlists and tracks, filter by exclusion status, and organize results.
- **Flexible layouts:** Switch between standard and compact playlist views.
- **Spotify-native experience:** A clean interface designed to blend seamlessly into Spotify through Spicetify.

Whether you use playlists for discovering new music, background listening, or organizing different genres, Taste Profile helps you keep your Spotify recommendations aligned with your actual musical preferences.

Excluding a playlist only affects listens from that playlist; excluding a track affects that song everywhere. Removing a playlist exclusion does not remove separately excluded tracks. Only playlists currently in your library are listed. Excluded tracks stay listed until you remove their exclusion (Spotify only stores exclusions — there is no “all not-excluded tracks” view).

The same setting in Spotify's playlist or track menu:

![Exclude from your taste profile][menu-screenshot]

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- GETTING STARTED -->

## Getting Started

### Develop

Spicetify Creator app (TypeScript / JSX). Source lives in `src/`.

Published Marketplace repo: [GZHN/taste-profile](https://github.com/GZHN/taste-profile). Workspace copy (if developing in the monorepo): `apps/taste-profile` in [spicetify-custom-apps](https://github.com/GZHN/spicetify-custom-apps).

```bash
npm install
npm run build          # → %appdata%\spicetify\CustomApps\taste-profile
spicetify config custom_apps taste-profile
spicetify apply
```

Watch (after one successful build):

```bash
npm run watch
# other terminal:
spicetify watch -la
```

For Marketplace / install scripts, commit a local build:

```bash
npm run build-local    # → dist/
```

### Publish an update

From this package (expects a clone at `GitHub/taste-profile` next to the monorepo). Bump `package.json` `"version"`, update [`CHANGELOG.md`](CHANGELOG.md), then sync (`src/version.ts` is regenerated on build).

```bash
# Windows (default npm script) — mirrors the package into the release clone
npm run sync-release
# or build + copy + commit + push in one go:
npm run sync-release -- -Push -Message "Release vX.Y.Z"

# macOS / Linux — copies a fixed set of package files (not a full mirror)
npm run sync-release:sh
# or:
npm run sync-release:sh -- --push -m "Release vX.Y.Z"
```

The PowerShell script (`scripts/sync-release.ps1`) robocopy-mirrors the package (excluding `node_modules` / `.git`). The shell script (`scripts/sync-release.sh`) copies a fixed allowlist (`src`, `dist`, `assets`, `scripts`, `README.md`, `CHANGELOG.md`, manifests, and package metadata). Prefer the Windows script when both environments are available so the release clone stays a full mirror.

Then open a GitHub release (`gh release create vX.Y.Z` in the release repo) and paste the matching `CHANGELOG.md` section. Marketplace reads `main`, so a push with updated `dist/` is enough for install scripts.

Root `manifest.json` is for [Marketplace](https://github.com/spicetify/marketplace/wiki/Publishing-to-Marketplace) (topic `spicetify-apps`).

### Prerequisites

- [Spicetify](https://spicetify.app/) 2.46 or newer
- Node.js + npm (to build from source)
- A Spotify client that Spicetify has already patched (`spicetify backup apply` on a fresh install)

### Installation

#### Installer

Requires a committed `dist/` from `npm run build-local` on the default branch.

| Platform       | Command |
| -------------- | ------- |
| Windows        | `iwr -useb https://raw.githubusercontent.com/GZHN/taste-profile/main/scripts/install.ps1 \| iex` |
| macOS / Linux  | `curl -fsSL https://raw.githubusercontent.com/GZHN/taste-profile/main/scripts/install.sh \| sh` |

From a clone with a built `dist/`, run `.\scripts\install.ps1` or `sh scripts/install.sh`.

#### Manual

1. Clone the repo and build
   ```bash
   git clone https://github.com/GZHN/taste-profile.git
   cd taste-profile
   npm install
   npm run build-local
   ```
2. Copy the contents of `dist/` into a folder named `taste-profile` under your Spicetify custom apps directory.

   | Platform      | Path                                           |
   | ------------- | ---------------------------------------------- |
   | Windows       | `%appdata%\spicetify\CustomApps\taste-profile` |
   | macOS / Linux | `~/.config/spicetify/CustomApps/taste-profile` |

3. Enable the app and restart Spotify
   ```bash
   spicetify config custom_apps taste-profile
   spicetify apply
   ```
4. Open **Taste Profile** from the sidebar.

### Uninstall

To remove the app, append a `-` after the folder name:

```bash
spicetify config custom_apps taste-profile-
spicetify apply
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- USAGE EXAMPLES -->

## Usage

- Switch between **Playlists** and **Excluded Tracks** tabs
- On Playlists: filter by **All**, **Excluded**, or **Not excluded**
- Search playlists by name, folder, or owner — or tracks by name, artists, or album
- Sort playlists by custom/library order, name, track count, or recently excluded; sort tracks by name, artist, album, or recently excluded
- Switch playlist **View as** Compact (no artwork, denser rows) or List (artwork + metadata); preference is remembered
- **Refresh** reloads exclusions and shows progress; last-updated time appears under the button
- The last tab, filters, search, sort, and playlist view mode are restored the next time you open the app
- **Exclude** or **Remove exclusion** updates the same setting as the playlist or track context menu
- Select rows for bulk exclude / remove-exclusion actions; large batches ask for confirmation
- **Undo** restores the last change
- Click a playlist or track name to open it in Spotify

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CHANGELOG -->

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history. Latest: **v1.6.1**.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ROADMAP -->

## Roadmap

See the [open issues](https://github.com/GZHN/taste-profile/issues) for proposed features and known issues.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTRIBUTING -->

## Contributing

If you have a suggestion that would make this better, fork the repo and open a pull request. You can also open an issue with the tag "enhancement".

1. Fork the project
2. Create your feature branch (`git checkout -b feature/my-change`)
3. Commit your changes (`git commit -m "Describe the change"`)
4. Push to the branch (`git push origin feature/my-change`)
5. Open a pull request

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Top contributors

<a href="https://github.com/GZHN/taste-profile/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=GZHN/taste-profile" alt="Contributors" />
</a>

<!-- CONTACT -->

## Contact

GZHN — [GitHub](https://github.com/GZHN)

Project link: [https://github.com/GZHN/taste-profile](https://github.com/GZHN/taste-profile)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ACKNOWLEDGMENTS -->

## Acknowledgments

- [Spicetify](https://spicetify.app/)
- [Exclude playlists or tracks from your taste profile](https://support.spotify.com/us/article/exclude-playlists-or-tracks-from-your-taste-profile/) (Spotify Support)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- MARKDOWN LINKS & IMAGES -->

[contributors-shield]: https://img.shields.io/github/contributors/GZHN/taste-profile.svg?style=for-the-badge
[contributors-url]: https://github.com/GZHN/taste-profile/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/GZHN/taste-profile.svg?style=for-the-badge
[forks-url]: https://github.com/GZHN/taste-profile/network/members
[stars-shield]: https://img.shields.io/github/stars/GZHN/taste-profile.svg?style=for-the-badge
[stars-url]: https://github.com/GZHN/taste-profile/stargazers
[issues-shield]: https://img.shields.io/github/issues/GZHN/taste-profile.svg?style=for-the-badge
[issues-url]: https://github.com/GZHN/taste-profile/issues
[product-screenshot]: assets/screenshots/taste-profile.png
[menu-screenshot]: assets/screenshots/spotify-menu.png
