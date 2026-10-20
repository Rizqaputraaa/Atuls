# Third-party notices

A-tuls is proprietary software. It includes the following open-source components, each used under its own licence.

| Component | Version | Licence | Use |
|---|---|---|---|
| Electron | 44 | MIT | App framework |
| ws | 8 | MIT | WebSocket connection between computers |
| koffi | 2 | MIT | Calls operating-system functions |
| uiohook-napi | 1.5 | MIT | Global keyboard and mouse hook |
| @nut-tree-fork/nut-js | 4.2 | Apache-2.0 | Cursor and key injection |
| @mediapipe/tasks-vision (and the Face Landmarker model) | 1.1 | Apache-2.0 | Head tracking for "Look to switch", runs only on this computer |
| mediaremote-adapter (macOS now-playing) | vendored | BSD-3-Clause | Reads the now-playing track on macOS (see `src/vendor/mediaremote/LICENSE`) |

Apache-2.0 components: licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). MIT and BSD components: the copyright notices and licence texts of each package are in its folder under `node_modules/` and in the vendored folder above.

Chromium and Electron's own notices are in `LICENSE` and `LICENSES.chromium.html` next to the application.

"Dynamic Island" is a trademark of Apple Inc.; A-tuls is not affiliated with or endorsed by Apple.
