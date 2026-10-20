# Arsitektur A-tuls

Dokumen ini menjelaskan cara kerja aplikasi. Tanggal terakhir diperbarui: 2026-10-19.

## 1. Gambaran besar

Dua komputer (Windows PC dan Mac) menjalankan aplikasi yang sama (Electron 44). Keduanya saling terhubung lewat WebSocket di LAN (`ws://<ip>:47800`). Satu sisi "mengendalikan" sisi lain: gerakan mouse, klik, scroll, ketikan, clipboard, file dan screenshot dikirim sebagai pesan JSON (file sebagai frame biner).

```
        PC (Windows)                                   Mac
 ┌───────────────────────────┐   WebSocket 47800   ┌───────────────────────────┐
 │ main.js  (Electron main)  │◄───────────────────►│ main.js                   │
 │  ├ link.js  (protokol)    │                     │  ├ link.js                │
 │  ├ native.js (koffi/hook) │                     │  ├ native.js (CoreGraphics)│
 │  ├ input.js ─ IPC ─► input-child.js (SendInput) │  ├ input-core.js          │
 │  ├ renderer/ (pill UI)    │                     │  ├ renderer/              │
 │  └ gaze (kamera, opsional)│                     │  └ gaze (kamera, opsional)│
 └───────────────────────────┘                     └───────────────────────────┘
```

## 2. Modul (folder `src/`)

| File | Fungsi |
| --- | --- |
| `main.js` | Titik masuk Electron: membuat jendela pill, tray/menu, polling hover, IPC renderer, penyimpanan pengaturan (`store`), hook watchdog, deteksi drop file di Mac (`pollMacDrop`), polling media (Windows), integrasi kamera/gaze. |
| `link.js` | Otak aplikasi: server+klien WebSocket, pairing, mesin status pointer, layout layar, pengiriman input/clipboard/file, takeback, edge resistance, smoothing gerakan, scroll. Hampir semua perilaku ada di sini. |
| `native.js` | Pemanggilan API sistem lewat **koffi** (FFI): hook mouse/keyboard Windows (`SetWindowsHookExW`), `SetCursorPos`, `GetAsyncKeyState`, timer 1 ms, penyembunyian kursor; di macOS CoreGraphics (`CGEventPost`, `CGEventTap` untuk scroll, `CGWarpMouseCursorPosition`), pembacaan pasteboard drag lewat Objective-C runtime. |
| `input.js` | Fasad penyuntik input. Di Windows meneruskan press/release/scroll/key ke proses pembantu `input-child.js` (lihat bagian 6). |
| `input-core.js` | Implementasi penyuntikan sebenarnya (nut-js + native). `scroll()`, `key()`, `press()`, `setPos()`, `getPos()`, `freelook()`. |
| `input-child.js` | Proses anak yang menjalankan `input-core` agar `SendInput` tidak dipanggil dari thread pemilik hook. |
| `smooth.js` | `WheelSmoother`: penghalusan scroll roda (step/speed/duration, mengikuti waktu nyata). |
| `layout.js` | Model layout layar dalam milimeter, perhitungan persilangan (`crossing`), penempatan awal. |
| `diag.js` | Log diagnostik (peristiwa, hitungan, pengukuran) + ringkasan yang bisa disalin. |
| `arrange.*` | Jendela "Arrange screens" untuk mengatur posisi layar secara fisik. |
| `renderer/` | UI pill (`index.html`, `app.js`, `style.css`) dan `preload.js` (jembatan IPC). |
| `gaze*.js`, `gaze.html`, `gaze-vendor/` | Fitur "Look to switch": pelacak kepala (MediaPipe Face Landmarker, berjalan lokal), kalibrasi, logika zona. |
| `media.ps1` | Membaca media yang sedang diputar di Windows (SMTC) termasuk cover. |
| `overlay*.{html,js}`, `pill.html` | Sisa pendekatan lama (overlay macOS) – sebagian masih dipakai di Mac. |

## 3. Protokol (pesan `t`)

Semua pesan JSON `{ t: '<jenis>', ... }`; file dikirim biner setelah `file-start` sampai `file-end`.

- Koneksi: `hello` (berisi `pin` atau `token`, info perangkat), `denied`, `ping`/`pong` (RTT), `rtoken` (token untuk koneksi balik tanpa kode).
- Layout: `layout`, `displays` (daftar layar + ukuran mm).
- Pointer: `attach`, `enter`, `leave`, `owner`, `takeback`, `release`, `move` (`dx,dy`, dibatch ±6 ms), `down`, `up`, `scroll` (`x,y` piksel, `n=1` jika dari roda dengan klik, 100 px per notch).
- Keyboard: `key`.
- Data: `clip`, `file-start`, `file-end`, `shot`.
- UI: `notice` (toast/kalibrasi di kedua sisi). Peer lama mengabaikan jenis yang tidak dikenal.

## 3b. Enkripsi (src/secure.js)

Koneksi WebSocket dibungkus `SecureChannel`. (1) Kedua sisi mengirim kunci publik X25519 efemeral dalam satu frame `kx` polos. (2) Rahasia bersama diturunkan dengan HKDF-SHA256 (salt = SHA-256 dari kedua kunci publik, juga dipakai sebagai `binding` sesi) menjadi dua kunci AES-256-GCM, satu per arah. (3) Setiap frame berikutnya = `[penghitung 8 byte][ciphertext][tag 16 byte]`, penghitung = nonce dan harus berurutan, sehingga replay, penghapusan, dan pengubahan ditolak. (4) Identitas dibuktikan dengan `HMAC(PIN atau token, label + binding)`: PIN/token tidak pernah dikirim; server membalas dengan bukti sendiri (`sproof`) agar klien tahu server asli. (5) Server mengunci 60 dtk dan mengganti PIN setelah 5 percobaan salah. Klien versi lama (tanpa `kx`) ditolak. (6) Pairing pertama dengan kode: setelah bukti PIN, kedua layar menampilkan 6 angka (SAS) yang diturunkan dari `binding` sesi; token baru dibagikan hanya setelah kedua orang menekan "They match". MITM punya dua sesi dengan binding berbeda, jadi angkanya berbeda dan orang menolak. Sambungan ulang dengan token tidak meminta angka. (7) Token (`tokens`, `peers`, `peerTokens`) disimpan terenkripsi `safeStorage` (DPAPI di Windows; Keychain di Mac hanya pada aplikasi terpasang). Pesan baru: `sas`, `sas-ok`, `sas-no`, `denied{sas}`.

## 4. Mesin status pointer

State: `idle`, `controlling` (saya mengendalikan peer), `controlled` (saya dikendalikan). `owner` = `me` / `peer` / null.

- **Crossing**: saat kursor menekan tepi layar ke arah peer (dan melewati edge resistance, default 20 px) komputer mengirim `attach`; peer menjawab dengan posisi masuk. Garis persilangan dihitung dari layout mm (`crossing()` menembak sinar maksimal 25 mm).
- **Konflik**: jika kedua sisi sama-sama ingin mengendalikan, id perangkat terkecil menang.
- **Takeback**: jika pengguna menyentuh mouse fisik komputer yang sedang dikendalikan, kendali dikembalikan. Windows: hook mouse (flag *injected*; `SetCursorPos` tampil sebagai non-injected sehingga dicocokkan dengan daftar posisi `recent` dan butuh 2 selisih); Mac: jam idle HID (`CGEventSourceSecondsSinceLastEventType`).
- **Penjaga**: drag guard (tombol ditahan), game/freelook guard (kursor disembunyikan / `ClipCursor`), watchdog hook (hook yang jatuh dipasang ulang), debounce perubahan layar (300 ms + 2 pembacaan sama).
- **Smoothing penerima**: tick 4 ms, 40% bagian per tick; timer Windows 1 ms (`timeBeginPeriod`).

## 5. Scroll

- Satuan internal: piksel, positif = ke bawah/kanan.
- Pengirim: Windows membaca `mouseData` dari hook (120 = 1 notch); Mac membaca `CGEventTap` (point delta, field 88 = kontinu/trackpad, 42 = penanda event buatan sendiri, 11/12 = baris).
- Roda dengan klik dikirim sebagai notch utuh (100 px) sehingga **penerima** menerapkan tuning-nya sendiri. Trackpad (kontinu) dikirim apa adanya.
- Penghalusan (`smooth.js`): setiap notch menambah "jarak tersisa" sebesar `step × gain` (gain naik dengan `speed` bila notch beruntun < 220 ms); timer 6 ms membayar jarak dengan ease-out eksponensial mengikuti waktu nyata, selesai ± `duration`.
- Tuning (`step`, `speed`, `duration`) tersimpan **per komputer** (`store: scrollTune`) dan tidak dikirim ke peer.
- Modifier (Ctrl/Alt/Shift/Win) ditahan → scroll tidak dihaluskan (zoom, scroll horizontal). Windows membaca status tombol dari sistem (`GetAsyncKeyState`).
- Mac: roda lokal yang dihaluskan diposting sebagai **salinan event asli** langsung ke proses di bawah pointer (`CGEventPostToPid`) agar tidak masuk lagi ke tap (ide dari proyek Mos; tidak ada kode yang disalin). Event buatan sendiri dikenali dari penanda field 42, jendela waktu 60 ms, dan state `controlled`.

## 6. Pelajaran penting (jangan diulang)

1. **Jangan panggil `SendInput` dari thread yang memiliki hook LL.** Itu menyebabkan deadlock/hang sistem. Karena itu semua injeksi Windows memakai proses anak.
2. **Jangan `uIOhook.stop()` saat input mengalir**; dapat deadlock dan membuat proses zombie yang tetap memegang hook. Windows hanya memasang ulang hook milik sendiri.
3. **Jangan force-kill proses utama bila bisa dihindari** (zombie memegang hook). Gunakan menu tray; `electron . --quit` kini tidak andal.
4. Panel Mac non-aktivasi tidak selalu menerima drop file; drop dideteksi native dari pasteboard drag + tombol mouse (`NSEvent pressedMouseButtons`, sebab `CGEventSourceButtonState` selalu false pada drag nyata di Mac pengguna).
5. Jendela transparan macOS: piksel transparan tembus klik/drag.
6. Event sintetis CGEvent dari proses uji tidak sampai ke jendela Electron lain untuk scroll; uji scroll Mac harus dengan aplikasi nyata dan pengguna.
7. Clipboard Electron 44 hanya promise API.
8. **Proses tak bisa dimatikan (zombie), 2026-10-19.** Satu proses utama tetap ada setelah dimatikan (`HasExited=True`, `Responding=False`, satu thread `Wait/UserRequest`, End Task dan `taskkill /F` gagal) sambil masih memegang soket `TCP 47800` dan `UDP 47801`. Pada saat yang sama log sistem mencatat driver Wi-Fi (Netwtw14) berulang kali reset dan adapter Ethernet hanya 10 Mbps, jadi dugaan terkuat: penutupan soket menunggu driver jaringan yang macet. Mitigasi di kode: (a) `link.stop()` memutus semua koneksi WebSocket secara eksplisit dan menghentikan timer, (b) penemuan perangkat (UDP) hanya memakai broadcast terarah ke jaringan privat yang aktif, bukan `255.255.255.255`, lebih jarang (4 dtk) dan berhenti sendiri setelah 5 kegagalan kirim, (c) `shutdownAll()` menutup soket, kamera, hook dan menampilkan kursor, lalu memaksa `app.exit` setelah 3 dtk, (d) berkas perintah `control.cmd` (`quit`/`restart`) agar skrip bisa menghentikan aplikasi dengan rapi, (e) instance kedua yang gagal mendapat kunci menampilkan pesan bukan keluar diam-diam. Proses yang sudah macet di kernel hanya hilang dengan restart Windows.

## 7. Data & konfigurasi

Disimpan di `store` (JSON di folder userData `A-tuls`): `deviceId`, daftar perangkat terakhir + token, `clipboard`, `smoothWheel`, `edgeResistance`, `freelookGuard`, `scrollSpeed`, `scrollReverse`, `scrollTune`, `tray` (daftar path), `gazeOn`, `gazeCal` (per peer), layout offset (mm). Diagnostik ditulis ke folder yang sama.

## 8. Fitur Look to switch

Kamera tersembunyi membaca landmark wajah (MediaPipe, delegate GPU lalu CPU) pada 24 fps / 640×480. Sinyal = posisi sepanjang garis antara dua titik (yaw, pitch) hasil kalibrasi. Dwell 140 ms, histeresis 25% setengah jarak, EMA α=0,6; wajah hilang = tidak pernah pindah. Pindah ditunda saat sedang mengetik (<1 s, maks 4 s). Jika PC sedang dikendalikan lalu pengguna menoleh ke Mac, `takeback` dikirim tanpa kamera Mac. Video tidak pernah dikirim.

## 8b. Perlindungan dari macet (guardian.js, instance.js)

Hook input global berjalan di proses utama, jadi proses utama yang membeku menyendatkan input seluruh komputer, dan thread yang tersangkut di Windows membuat proses tak bisa dimatikan (zombie yang menahan port dan kunci instance). Perlindungan berlapis: (1) `guardian.js`, proses terpisah (detached agar tidak ikut mati bersama aplikasi), menerima detak tiap 1 detik dari proses utama; 10 detik tanpa detak = `SIGKILL` pada aplikasi lalu start salinan baru (maksimal 3 kali berturut-turut; jeda tidur tidak dihitung); (2) `instance.js` menentukan folder data sebelum pengaturan dibaca: bila kunci dipegang proses yang sudah mati (process id di `instance.pid`, atau tidak ada yang menjawab di port bila tidak ada catatan), dipakai folder kedua dengan salinan `config.json` dan `Local State`; (3) server mencoba port 47800..47809 dan mengumumkan port nyata lewat discovery; (4) pekerjaan yang bisa lama (ukuran monitor lewat PowerShell) tidak boleh berjalan sinkron di proses utama.

## 9. Keterbatasan yang diketahui

- Lalu lintas LAN terenkripsi (lihat bagian 3b), tetapi desainnya belum diaudit pihak luar; PIN pairing 6 digit lemah terhadap MITM aktif saat pairing pertama.
- Media "now playing" hanya di Windows; Mac belum.
- Kalender masih tampilan tanpa data (belum terhubung ke Google/iPhone).
- Mac sesekali perlu `kill -9`; pernah SIGABRT di uiohook-napi saat shutdown.
- Satu PC + satu Mac; belum ada lebih dari 2 perangkat.
- Akurasi Look to switch belum diukur pada banyak wajah/kamera.
