# Yabai Focus

Local Raycast extension for fuzzy-searching currently open yabai windows and focusing the selected window.

It is built for macOS setups that use `yabai` for window focus and want an `alt-space` app/window switcher without replacing existing `skhd` fixed app hotkeys.

## Command

- `Focus App`: queries `yabai -m query --windows`, lists focusable windows, and focuses the selected window with `yabai -m window --focus <window-id>`.
- Hidden, minimized, and non-AX windows are ignored.
- When the command opens, it performs a few quiet follow-up queries in the first few seconds so apps/windows opened at the same time can appear without reopening Raycast.
- If yabai focus fails, the command falls back to `open -a <app-name>`.

## Setup

```sh
npm install
npm run dev
```

Raycast imports the local extension when `npm run dev` starts. After that, the command remains available from Raycast root search.

## Hotkey

In Raycast Settings -> Extensions, select `Focus App` and record `Option-Space` as the command hotkey.

## Requirements

- `yabai` must be installed and running.
- `yabai` needs macOS Accessibility permissions.
- Raycast may also need Accessibility permissions so the focused app/window switch is allowed by macOS.
- The extension searches for binaries with this PATH:

```text
/Users/${USER}/.nix-profile/bin:/nix/var/nix/profiles/default/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
```

## Usage

1. Press the configured hotkey.
2. Type part of an app or window title.
3. Press Enter to focus the selected yabai window.

The action panel also includes:

- `Refresh` with `Cmd-R`.
- `Copy Yabai Focus Command` with `Cmd-.`.

## Checks

```sh
npm run format:check
npm run lsp
npm run lint
npm run build
```

CI runs the same checks with:

```sh
npm run ci
```

## Troubleshooting

- If the list is empty, confirm the window is not hidden, minimized, or missing an Accessibility reference in yabai.
- If Raycast cannot find `yabai`, verify it is installed in one of the PATH directories above.
- If focusing fails, confirm both yabai and Raycast have macOS Accessibility permissions.
