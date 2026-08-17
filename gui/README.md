# Instlux GUI (Tauri shell)

Natív, nem-Electron felület az Instlux (instagram-cli fork) fölé.

## Architektúra

```
┌─────────────────────┐   stdin/stdout    ┌──────────────────────────┐
│  Rust / Tauri shell  │ ◄── JSON-RPC ───► │  Node sidecar             │
│  (src-tauri/)         │   newline-      │  dist/gui-bridge.js       │
│  + rendszer webview   │   delimited     │  (source/gui-bridge.ts    │
│  (src/ - vanilla JS)  │                 │   wrapolja InstagramClient)│
└─────────────────────┘                   └──────────────────────────┘
```

Semmi Electron, semmi becsomagolt Chromium — a Rust oldal a rendszer
webview-ját használja (Linuxon WebKitGTK), a Node sidecar pedig a már
meglévő, karbantartott `InstagramClient`-et futtatja változatlanul.

## Előfeltételek (CachyOS / Arch)

```bash
sudo pacman -S --needed rust webkit2gtk-4.1 base-devel curl wget \
  file openssl appmenu-gtk-module gtk3 libappindicator-gtk3 \
  librsvg patchelf

cargo install tauri-cli --version "^2" --locked
```

Node.js (v22+) legyen telepítve — ez már megvan neked.

## Build lépések

1. Buildeld a Node sidecart a repo gyökeréből (ha még nem tetted meg):

   ```bash
   cd Instlux
   npm install
   npm run build      # létrehozza a dist/gui-bridge.js-t is
   ```

2. Fejlesztői mód (élő újratöltéssel a frontendhez):

   ```bash
   cd gui/src-tauri
   cargo tauri dev
   ```

3. Éles bináris (AppImage / deb / rpm a `tauri.conf.json` bundle
   targets alapján):

   ```bash
   cd gui/src-tauri
   cargo tauri build
   ```

   A csomagolt binárisok itt lesznek: `gui/src-tauri/target/release/bundle/`.

   **Fontos:** éles buildhez a `dist/gui-bridge.js`-t és a hozzá tartozó
   `node_modules`-t resource-ként be kell venni a `tauri.conf.json`
   `bundle.resources` mezőjébe (vagy egy `ncc`/`pkg`-vel önálló bináris
   csinálva belőle), különben a felhasználó gépén nem fogja megtalálni a
   sidecart futásidőben. Ez a jelenlegi konfigban még nincs bekötve —
   dev módban a relatív `../../dist/gui-bridge.js` útvonalat használja.

## Jelenlegi állapot / MVP

Amit már tud a `src/main.js`:
- bejelentkezés (jelszóval)
- thread lista betöltése és megjelenítése
- egy thread megnyitása, üzenetek betöltése
- üzenetküldés
- realtime "connected/connecting/disconnected" jelzés a bal felső sarokban

Amit még **nem** kezel (jó folytatási pontok):
- kétfaktoros / checkpoint login flow a GUI-ból (egyelőre a CLI-vel kell
  egyszer bejelentkezni, utána a session fájlt a GUI is használni tudná
  a `loginBySession` RPC metóduson keresztül — ezt még be kell kötni a
  login formba fallbackként)
- reakciók, "seen" jelzés megjelenítése
- kép/videó küldés és megjelenítés (a `client.ts`-ben megvan: `sendPhoto`,
  `sendVideo`, `downloadMediaFromMessage` — ezeket még nem exponáltuk a
  `gui-bridge.ts`-ben)
- több fiók kezelése (a bridge jelenleg egyetlen aktív `InstagramClient`
  példányt tart)
- stories / feed nézet
