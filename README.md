# EFTconsole

A terminal for macOS and Windows dressed up in an *Escape from Tarkov*-inspired
interface: khaki-on-black palette, tactical tab bar, film grain and scanlines,
a "deploying" boot screen, CPU/MEM health bars and a raid timer.

![EFTconsole screenshot](docs/screenshot.png)

> Fan-made project. Not affiliated with, endorsed by, or connected to Battlestate Games.
> *Escape from Tarkov* is a trademark of its respective owner. No game assets are used.

## Features

- Real shell via [node-pty](https://github.com/microsoft/node-pty) + [xterm.js](https://xtermjs.org):
  zsh/bash on macOS, PowerShell 7 (`pwsh`) or Windows PowerShell on Windows
- Tabs, clickable links, truecolor, 10k-line scrollback
- Status bar: PMC callsign, location (hostname), shell, CPU/MEM meters, time in raid, clock
- Shell exit screen: **SURVIVED** on exit code 0, **KILLED IN ACTION** otherwise —
  `Enter` to redeploy, `Esc` to close the tab
- Config file at `~/.eftconsole.json`

## Install

Grab the `.dmg` (macOS) or `.exe` installer (Windows) from
[Releases](https://github.com/dzotyara/EFTconsole/releases).

Builds are not code-signed. On macOS, if Gatekeeper says the app is damaged:

```bash
xattr -cr /Applications/EFTconsole.app
```

On Windows, SmartScreen may warn on first launch: *More info → Run anyway*.

## Run from source

Requires Node.js 22.12+.

```bash
npm install
npm start
```

Build installers locally:

```bash
npm run dist:mac   # dist/EFTconsole-<version>-mac-<arch>.dmg
npm run dist:win   # dist/EFTconsole-<version>-win-x64.exe
```

Pushing a `v*` tag makes GitHub Actions build both platforms and attach them to a release.

## Shortcuts

| Action           | macOS            | Windows                     |
| ---------------- | ---------------- | --------------------------- |
| New tab          | `Cmd+T`          | `Ctrl+Shift+T`              |
| Close tab        | `Cmd+W`          | `Ctrl+Shift+W`              |
| Next / prev tab  | `Ctrl+Tab` / `Ctrl+Shift+Tab` | same           |
| Go to tab 1–9    | `Cmd+1…9`        | `Ctrl+1…9`                  |
| Copy             | `Cmd+C`          | `Ctrl+C` (with selection), `Ctrl+Shift+C` |
| Paste            | `Cmd+V`          | `Ctrl+V`, `Ctrl+Shift+V`    |
| Clear            | `Cmd+K`          | `Ctrl+Shift+K`              |
| Font size        | `Cmd+=` / `Cmd+-` / `Cmd+0` | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |

Right click copies the selection, or pastes when nothing is selected.

## Config

Click the gear in the title bar (or *Shell → Open Config* on macOS) to create and open
`~/.eftconsole.json`. Every key is optional; restart the app to apply changes.

```json
{
  "shell": null,
  "shellArgs": null,
  "fontSize": 14,
  "fontFamily": null,
  "bootAnimation": true,
  "scanlines": true,
  "cursorBlink": true,
  "callsign": null
}
```

- `shell` / `shellArgs` — e.g. `"C:\\Program Files\\Git\\bin\\bash.exe"` and `["--login"]`
- `fontFamily` — CSS font stack, defaults to JetBrains Mono → Cascadia Mono → SF Mono → Menlo → Consolas
- `callsign` — name shown after **PMC** in the status bar (defaults to your OS user name)

For the most authentic look, install the free **Bender** font: the UI picks it up automatically
and falls back to Bahnschrift (Windows) or DIN Condensed (macOS).

---

## По-русски

Терминал для macOS и Windows в стилистике интерфейса *Escape from Tarkov*.
Фанатский проект, не связан с Battlestate Games, игровые ассеты не используются.

- Установщики — во вкладке [Releases](https://github.com/dzotyara/EFTconsole/releases)
- Из исходников: `npm install`, затем `npm start` (нужен Node.js 22.12+)
- Настройки — шестерёнка в заголовке окна, файл `~/.eftconsole.json`
- Шелл завершился с кодом 0 — **SURVIVED**, иначе **KILLED IN ACTION**; `Enter` — заново, `Esc` — закрыть вкладку

## License

[MIT](LICENSE)
