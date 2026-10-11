# Desk Reject

A Reviewer 2 soundboard for research meetings. Press a comment and it is read aloud; press the stamp and Reviewer 2 picks one for you.

![Desk Reject](docs/screenshot.png)

It is a single static web page: no account, no server, no build step. It runs in any modern browser and can be installed as an app on a Mac, on Windows or on a phone.

## What it does

- **Four banks of sixteen pads.** The board is a 4 × 4 grid of rubber pads, like a drum machine, loaded with classics ("Why should I care?", "Is this economics?", "Correlation is not causation."). Each pad is read aloud by your computer's voice and lights up while it plays. Banks *A*–*D* switch the whole grid, like a drum machine: *A* holds the preset, the others start empty, and any blank pad with a **+** lets you write a new comment, record one with your own voice, or bring an existing one there.
- **Reviewer 2 decides.** The red stamp plays a random comment, never the same one twice in a row. By default it draws from the pads and from a reserve of 22 more comments that are not on a pad.
- **Your own board.** Under *Edit pads* you can add, edit, move and delete comments, and mark them as comment, revise or reject. Drag a pad onto another pad to swap them, onto a bank button to move it to that bank, or onto the *Reserve* to take it off the grid; *Remove from pad* and *Add to pad* do the same with a click.
- **Your own voice.** Any comment can be recorded from the microphone; the recording then plays instead of the system voice.
- **Share a board.** *Settings → Export board* saves the comments and recordings to a JSON file. A colleague imports it with *Import board*.

Keyboard: <kbd>Space</kbd> plays a random comment; <kbd>←</kbd> <kbd>→</kbd> switch bank; the pads follow the keyboard grid <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd><kbd>4</kbd> / <kbd>Q</kbd><kbd>W</kbd><kbd>E</kbd><kbd>R</kbd> / <kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><kbd>F</kbd> / <kbd>Z</kbd><kbd>X</kbd><kbd>C</kbd><kbd>V</kbd>; <kbd>Esc</kbd> stops. Right-click (or long-press on a touch screen) a pad to edit or record it.

## Install it as an app

Open the site, then:

- **Mac, Safari (macOS Sonoma or later):** *File → Add to Dock*. It gets its own window, Dock icon and Launchpad entry.
- **Chrome or Edge:** the install icon at the right end of the address bar.
- **iPhone or iPad:** *Share → Add to Home Screen*.

After the first visit it also works offline.

## Privacy

Everything stays in the browser that uses it. Comments and settings live in `localStorage`, recordings in IndexedDB. Nothing is uploaded, and there is no analytics.

## Voices

Speech comes from the Web Speech API, which uses the voices installed on each computer, so the same board can sound different on two machines. On a Mac, better voices (for example *Daniel (Enhanced)*) can be downloaded in *System Settings → Accessibility → Spoken Content*. Settings lets you pick a voice and change speed and pitch.

The repository deliberately contains **no generated audio**. Audio produced by operating-system voices usually may not be redistributed, so the app synthesises speech on each device instead. Recordings you make stay on your computer unless you export them.

## Run it locally

```bash
git clone https://github.com/<you>/desk-reject.git
cd desk-reject
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` directly also works, but browsers only allow microphone recording on `https://` or `localhost`.

## Publish your own copy on GitHub Pages

1. Push the repository to GitHub.
2. *Settings → Pages → Build and deployment → Source: GitHub Actions*.
3. The workflow in `.github/workflows/pages.yml` publishes the site on every push to `main`, at `https://<you>.github.io/desk-reject/`.

## Desktop app (macOS, Windows, Linux)

The same page also ships as a desktop app built with [Electron](https://www.electronjs.org/). It adds a few things a browser cannot:

- the app icon follows the system's light or dark appearance: on macOS 26 and later everywhere (Dock, Finder, Launchpad), even when the app is closed, thanks to an Icon Composer icon (`build/AppIcon.icon`) compiled at build time; on older macOS, Windows and Linux it switches while the app runs;
- at startup it checks the repository's GitHub Releases and, if there is a newer version, offers to open the download page (*Check for Updates…* in the app menu does the same on demand);
- it keeps its own storage, separate from any browser.

Run it from the repository:

```bash
npm install
npm start
```

Build installers locally with `npm run dist:mac`, `npm run dist:win` or `npm run dist:linux` (output in `dist/`).

### Releasing a new version

1. Set your GitHub username in `package.json` → `repository.url`.
2. `npm version patch` (or `minor`, `major`), then `git push --follow-tags`.
3. The workflow in `.github/workflows/release.yml` builds the macOS (`.dmg` and `.zip` for Apple Silicon and Intel), Windows (`.exe`) and Linux (`.AppImage`) apps and attaches them to a GitHub release. Installed copies see the new version at their next start.

The macOS build is ad-hoc signed but not signed with an Apple Developer ID. The first time, macOS blocks it: open *System Settings → Privacy & Security* and press *Open Anyway*. Building the macOS 26 icon needs Xcode 26; without it the build still works, with the light icon only. For the same reason updates are offered as a download rather than installed silently.

## Change the built-in comments

The preset lives in [`assets/presets.js`](assets/presets.js). Each comment has `text`, a `severity` (`comment`, `revise` or `reject`) and `board` (`true` for a pad, `false` for the random reserve). People who have already opened the app keep their own board until they choose *Reset to the Reviewer 2 preset*.

When you change any file listed in `sw.js`, bump `VERSION` there so installed copies pick up the update.

## Project layout

```
index.html            page structure
assets/app.js         behaviour (plain JavaScript, no dependencies)
assets/presets.js     built-in board
assets/style.css      typesetting and layout
assets/fonts/         Computer Modern Unicode (OFL)
assets/icons/         app icons
manifest.webmanifest  install metadata
sw.js                 offline cache (web version)
electron/             desktop shell: main process and preload
build/                desktop app icons for the installers (AppIcon.icon: Icon Composer, light + dark)
build-scripts/        afterPack hook: compiles the macOS 26 icon with actool, ad-hoc signs the app
package.json          desktop app version, scripts and build settings
```

## License

Code: MIT, see [LICENSE](LICENSE). Fonts: Computer Modern Unicode, SIL Open Font License 1.1, see [assets/fonts/OFL.txt](assets/fonts/OFL.txt).
