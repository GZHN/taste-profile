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
    <img src="assets/logo/logo.svg" alt="Taste Profile logo" width="120" height="120">
  </a>

<h3 align="center">Taste Profile</h3>

  <p align="center">
    A Spicetify app that lists playlists excluded from your taste profile, so you can include or exclude them from one place.
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
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#built-with">Built With</a></li>
      </ul>
    </li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation</a></li>
        <li><a href="#uninstall">Uninstall</a></li>
      </ul>
    </li>
    <li><a href="#usage">Usage</a></li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#contact">Contact</a></li>
    <li><a href="#acknowledgments">Acknowledgments</a></li>
  </ol>
</details>

<!-- ABOUT THE PROJECT -->

## About The Project

[![Taste Profile listing excluded playlists][product-screenshot]](https://support.spotify.com/us/article/exclude-playlists-or-tracks-from-your-taste-profile/)

Taste profile is Spotify's interpretation of your taste based on what you listen to and how you listen to it. Spotify uses it to personalize recommendations, like Discover Weekly and your Home page, and experiences with taste summaries, like Wrapped and Blend.

In Spotify, that setting lives on each playlist menu, so there is no list of which playlists are excluded. This app shows them together, so you can see the setting and change it for any playlist from one place.

Playlists you excluded and later removed from your library stay listed until you include them again.

The same setting in Spotify's playlist menu:

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

- Filter by **All**, **Excluded**, **Included**, or **Not in library**
- **Not in library** lists playlists you excluded and later removed from your library
- Search by playlist name, folder, or owner
- Lists stay in alphabetical order
- The reload icon beside the title loads the library again and shows progress
- The last filter and search are restored the next time you open the app
- **Exclude** or **Include** updates the same setting as the playlist context menu
- Select playlists to include or exclude them together, or use **Include all** / **Exclude all** for the current view
- **Undo** restores the last change
- Select a playlist name to open it

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
[spotify-shield]: https://img.shields.io/badge/Spotify-1ED760?&style=for-the-badge&logo=spotify&logoColor=white
[spotify-url]: https://spotify.com
[product-screenshot]: assets/screenshots/taste-profile.png
[menu-screenshot]: assets/screenshots/spotify-menu.png
[spicetify-shield]: https://img.shields.io/badge/Spicetify-1ED760?style=for-the-badge
[spicetify-url]: https://spicetify.app/
