# Captcha Plugin: Turnstile Solver by Raptor

A Chrome extension (Manifest V3) that automatically solves Cloudflare Turnstile challenges. Completely free, no registration or key purchase required.

## Features

- Automatically solves Cloudflare Turnstile widgets on web pages.
- Runs entirely locally — no data is sent outside.
- Enable/disable the solver and configure the solve delay via the popup UI.
- Extension icon reflects the current state.
- UI localized into 11 languages (en, ru, de, es, fr, ar, id, ja, ms, pt, zh).

## Installation

1. Download or clone the repository.
2. Open `chrome://extensions` in a Chromium-based browser.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the project folder.

## Usage

After installing, click the extension icon in the toolbar to:

- toggle automatic solving on/off (**Solver enabled**);
- set the delay before solving, in milliseconds (**Delay**).

## Project structure

```
manifest.json           Extension manifest (MV3)
background.js           Service worker, settings storage, messaging
popup.html / popup.js / popup.css   Extension settings UI
captcha/turnstile.js         Content script injected into Cloudflare's challenge platform pages
captcha/turnstile_cdp.js     Turnstile solving logic
icon/                    Extension icons
_locales/                UI translations
```

## Permissions

- `debugger` — used to solve the challenge.
- `storage` — stores user settings.
- `host_permissions` for `challenges.cloudflare.com` and `challenges.fed.cloudflare.com`.

## Requirements

Chrome version 111 or later.
