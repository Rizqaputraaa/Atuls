# Brief untuk audit eksternal (Gemini)

Dokumen ini berisi semua pengetahuan yang dibutuhkan penilai luar untuk mengaudit **A-tuls** dan memberi saran. Cara pakai: unggah/tempel file ini **bersama** isi folder `src/` (terutama `link.js`, `main.js`, `native.js`, `input-core.js`, `smooth.js`, `discovery.js`, `renderer/*`) dan dokumen `docs/ARSITEKTUR.md`, `docs/KOMERSIAL.md`. Jawab dalam bahasa Indonesia.

---

## 1. Produk dalam satu paragraf

A-tuls adalah aplikasi desktop (Electron 44 + Node) untuk **Windows 10/11 dan macOS**: sebuah "pill" ala Dynamic Island di tepi atas layar, ditambah **berbagi mouse + keyboard + clipboard + file + screenshot** antar dua komputer di LAN (seperti Synergy/ShareMouse/WingDeck), pindah komputer cukup dengan **menggeser pointer keluar tepi layar** atau (opsional) **menoleh** (webcam lokal). Target: dijual sebagai utilitas desktop (Free + Pro), didistribusikan lewat GitHub Releases/situs sendiri (bukan App Store). Pengguna utama: pemilik PC Windows + MacBook di satu meja.

## 2. Stack & batasan

- Electron 44, Node 24 di dev, JavaScript (CommonJS), tanpa TypeScript, tanpa framework UI (HTML/CSS/JS biasa).
- Native lewat **koffi** (FFI): Windows `SetWindowsHookExW` (hook LL mouse/keyboard), `SetCursorPos`, `GetAsyncKeyState`, `timeBeginPeriod`; macOS CoreGraphics (`CGEventPost`, `CGEventTap`, `CGEventPostToPid`), Objective-C runtime (pasteboard drag), simbol privat `CGSGetSymbolicHotKeyValue`.
- `uiohook-napi` (hook global + injeksi key), `@nut-tree-fork/nut-js`, `ws` (WebSocket), `@mediapipe/tasks-vision` (kepala), `electron-builder` (kemasan).
- Transport: WebSocket `ws://<ip>:47800` (JSON + frame biner untuk file); penemuan perangkat: UDP broadcast port 47801.
- Satu pengembang, uji manual (belum ada CI untuk uji integrasi), hanya satu PC + satu Mac untuk pengujian.
- Ukuran kode: ± 4.300 baris (`link.js` 1.040, `main.js` 720, `native.js` 565, renderer ± 960).

## 3. Fitur yang sudah ada

Pointer lintas layar (layout mm multi-monitor, edge resistance, takeback fisik, game guard), keyboard (Cmd↔Win), clipboard teks+gambar, file tray + kirim file, screenshot lintas OS, smooth wheel + tuning (step/speed/duration, per perangkat), pemetaan tombol per perangkat (thumb wheel, back/forward, back+forward, tekan roda → desktop kiri/kanan, Mission Control, dll.), color picker (layar dibekukan + loupe → hex ke clipboard), pairing PIN + token, daftar perangkat terdekat (UDP) dan terakhir, media now playing + cover (Windows), kalender mingguan (statis), Look to switch (kepala, MediaPipe lokal), diagnostik bawaan.

## 4. Pelajaran/jebakan yang sudah ditemukan (agar tidak diulang)

1. `SendInput` dari thread pemilik hook LL → deadlock/hang sistem. Solusi: proses anak `input-child.js`.
2. Jangan `uIOhook.stop()` saat input mengalir; jangan kill paksa proses (zombie memegang hook).
3. Panel macOS non-aktivasi tidak menerima drop file; deteksi native via pasteboard drag + `NSEvent pressedMouseButtons` (`CGEventSourceButtonState` selalu false pada drag nyata).
4. Event tap scroll menelan event buatan sendiri → loop (diperbaiki: penanda field 42, jendela waktu, state `controlled`, `CGEventPostToPid`).
5. Ctrl/Alt/Shift + wheel (zoom) harus lolos penghalusan → baca status tombol dari sistem.
6. Single-instance lock dan `--quit` tidak andal; sempat muncul 4 instance sekaligus.
7. `desktopCapturer.getSources({ thumbnailSize })` butuh `{width,height}` (bug picker kemarin).

## 5. Masalah terbuka / ketidakpastian

- **Keamanan:** lalu lintas LAN sudah **terenkripsi** (`src/secure.js`, protokol buatan sendiri di atas primitif `node:crypto`; mohon dibedah, lihat pertanyaan A1); PIN 6 digit dikunci setelah 5 salah; token masih tersimpan plaintext di config.
- Akurasi "Look to switch" belum diukur pada banyak wajah/kamera/pencahayaan.
- Media "now playing" hanya Windows; kalender belum terhubung ke data nyata.
- Stabilitas Mac: sesekali `kill -9`, pernah `SIGABRT` di uiohook-napi saat shutdown.
- Belum teruji: Windows↔Windows (kode simetris, belum diuji di dua PC), Mac↔Mac, lebih dari dua perangkat, build `.dmg` (hanya `.exe` yang sudah dibuild).
- Aksi desktop kiri/kanan di Mac memakai pembacaan pintasan sistem; belum divalidasi lintas versi macOS.
- Tidak ada pengujian otomatis untuk protokol/state machine (`link.js`) dan layout.
- Kemasan tidak ditandatangani (Gatekeeper/SmartScreen), tanpa auto-update.
- Folder `Referensi/` berisi proyek pihak ketiga berlisensi GPL-3.0 / CC BY-NC (hanya ide yang dipakai, tidak ada kode disalin) → tidak boleh ikut dalam distribusi.

## 6. Pertanyaan audit (jawab satu per satu, beri prioritas P0/P1/P2)

### A. Keamanan
1. **Bedah `src/secure.js` dan bagian pairing di `link.js` (`accept`/`connect`).** Desainnya: X25519 efemeral, HKDF-SHA256 (salt = hash kedua kunci publik), dua kunci AES-256-GCM per arah, nonce = penghitung 64-bit yang harus berurutan, bukti HMAC(PIN/token, label + binding sesi) menggantikan pengiriman PIN. Cari kelemahan: apakah ada serangan MITM/replay/reflection/downgrade yang lolos? Apakah PIN 6 digit cukup untuk pairing pertama (serangan offline oleh MITM aktif)? Sebaiknya diganti SPAKE2/Noise_XXpsk atau ditambah angka verifikasi (SAS)? Apakah menyimpan token di `electron-store` perlu `safeStorage`?
2. Ancaman yang realistis di LAN (kafe, kantor, Wi-Fi bersama): keylogging lewat sniffing, pairing paksa, replay, penyuntikan input dari luar. Apa mitigasi minimum?
3. Penyimpanan token/PIN dan data (`electron-store`): perlu keychain/DPAPI?
4. Risiko hook global/penyuntikan input dari sisi antivirus, anti-cheat, dan kebijakan Apple (TCC).

### B. Arsitektur & kualitas kode
5. `link.js` (1.000+ baris) menampung protokol, state machine, layout, scroll, aksi tombol. Usul pemecahan modul yang aman (tanpa regresi).
6. Penanganan error, race condition, dan state yang bocor (mis. tombol/modifier menempel, kursor tersembunyi, hook yang jatuh).
7. Pemisahan proses (helper input di Windows) – adakah risiko lain, atau perlu pola serupa di Mac?
8. Strategi pengujian: bagaimana menguji state machine pointer tanpa dua komputer fisik (simulator/dependency injection)?

### C. Performa & rasa pakai
9. Latensi pointer: batching 6 ms, smoothing 4 ms/40%; apakah ada pendekatan lebih baik (prediksi, interpolasi, UDP untuk move)?
10. Penghalusan scroll (ease-out eksponensial berbasis waktu): bandingkan dengan pendekatan Mos/LinearMouse/macOS native; saran parameter bawaan.
11. Konsumsi CPU/baterai (polling hover 60 ms, polling drop Mac 40 ms, polling media PowerShell tiap 3 s, kamera 24 fps) dan cara mengurangi.

### D. UI/UX
12. Alur pertama kali (onboarding izin macOS: Accessibility, Input Monitoring, Screen Recording, Camera; firewall Windows). Usul layar panduan.
13. Konsistensi tab (Anathema/Tray/Link/Settings), ikon, ukuran panel, teks bantuan, aksesibilitas (kontras, keyboard navigation).
14. Pesan kesalahan dan status koneksi sudah memadai? Apa yang hilang (mis. indikator "sedang mengendalikan", pemutusan otomatis, reconnect)?

### E. Produk & bisnis
15. Positioning terhadap pesaing (Mouse Without Borders, ShareMouse, Synergy/Input Leap, Logitech Flow, Universal Control, NotchNook): fitur apa yang menjadi alasan membeli, fitur apa yang harus gratis.
16. Model harga (Free + Pro sekali bayar US$19–29, opsi langganan untuk cloud) – kritik dan alternatif.
17. Risiko hukum: merek ("Dynamic Island" milik Apple), lisensi dependensi (lihat `docs/KOMERSIAL.md`), privasi kamera (GDPR/UU PDP), EULA.
18. Rencana distribusi: GitHub Releases/situs sendiri, code signing (Apple Developer, sertifikat Windows/Azure Trusted Signing), auto-update, notarization.

### F. Roadmap
19. Urutan pekerjaan yang masuk akal dari kondisi sekarang menuju beta tertutup lalu rilis berbayar (perkiraan usaha tiap tahap).
20. Fitur yang sebaiknya **dibuang/ditunda** agar fokus.

## 7. Format jawaban yang diminta

- Ringkasan eksekutif (maks. 10 baris).
- Tabel temuan: `ID | Area | Temuan | Dampak | Saran | Prioritas (P0/P1/P2) | Usaha (S/M/L)`.
- Untuk tiap temuan P0: langkah perbaikan konkret (pseudocode/arsitektur, bukan sekadar nasihat umum).
- Pisahkan **fakta dari kode** vs **asumsi** (sebutkan bila sesuatu tidak bisa dipastikan dari file yang diberikan).
- Jangan menyarankan menyalin kode dari proyek GPL / CC BY-NC.
- Jangan menyarankan menulis ulang total; saran harus bisa dikerjakan bertahap oleh satu orang.

## 8. Peta file ringkas

| File | Isi |
| --- | --- |
| `src/main.js` | Jendela, IPC, hover/drop polling, color picker, shortcut global, media, kamera |
| `src/link.js` | Protokol WebSocket, pairing, state machine pointer, layout, scroll, aksi tombol |
| `src/native.js` | Windows hook/FFI, macOS CoreGraphics/ObjC, event tap scroll, hotkey sistem, pasteboard drag |
| `src/input-core.js`, `input.js`, `input-child.js` | Injeksi input (Windows lewat proses anak) |
| `src/smooth.js` | Penghalusan scroll (step/speed/duration) |
| `src/discovery.js` | UDP broadcast penemuan perangkat |
| `src/layout.js`, `arrange.*` | Model layout mm dan jendela Arrange |
| `src/gaze*.js`, `gaze.html`, `gaze-vendor/` | Look to switch |
| `src/picker.html`, `picker-preload.js` | Color picker (screen dibekukan + loupe) |
| `src/renderer/*` | UI pill (4 tab) |
| `src/diag.js` | Log & ringkasan diagnostik |
| `docs/` | ARSITEKTUR, PANDUAN-DEVELOPER, KOMERSIAL, INSTALASI, CHANGELOG, dokumen ini |

## 9. Kontak konteks

Pemilik proyek berkomunikasi dalam bahasa Indonesia, menguji secara manual di PC Windows (ultrawide + monitor vertikal) dan MacBook (notch), memakai mouse ProtoArc EM25 (thumb wheel) dan ingin hasilnya dijual. Prioritas sekarang: UI/UX dan fitur inti, bukan monetisasi (monetisasi untuk nanti).
