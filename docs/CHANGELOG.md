# Riwayat pengembangan (urut kronologis)

Belum ada rilis resmi; daftar ini merangkum apa yang dibangun dan diperbaiki.

## Fondasi
- Aplikasi Electron + Node dengan pill ala Dynamic Island (Windows: tengah atas; Mac: mengikuti notch).
- Tab media (now playing), file tray (drop/seret keluar), link antar komputer lewat WebSocket + pairing PIN 6 digit + token perangkat tepercaya, daftar perangkat terakhir.
- Berbagi pointer, klik, scroll, keyboard (Cmd ↔ Win), clipboard teks dan screenshot, transfer file, tombol samping mouse sebagai pintasan screenshot.

## Pointer dan layar
- Layout multi-monitor dalam milimeter (jendela Arrange), persilangan dengan sinar maks. 25 mm, penempatan awal otomatis, migrasi offset lama.
- Akurasi pendaratan ≈ 0,5 px; smoothing penerima; batching gerakan; timer 1 ms di Windows.
- Edge resistance (slider), penjaga drag, penjaga game/freelook, watchdog hook, debounce perubahan layar.
- Takeback fisik (hook Windows; jam idle HID di Mac), resolusi konflik (id terkecil menang).

## Stabilitas
- Insiden hang PC: penyebab `SendInput` dari thread pemilik hook → injeksi dipindah ke proses anak; `uIOhook.stop()` tidak dipanggil saat input mengalir; kursor dipulihkan saat keluar.
- Diagnostik bawaan (log, ringkasan, tombol salin) untuk mengukur akurasi dan bug.

## Scroll
- Scroll piksel presisi lewat CGEventTap (Mac) dan hook (Windows); kecepatan dan arah terbalik.
- Smooth wheel di kedua sisi; ditulis ulang agar mengikuti waktu nyata; tuning per perangkat (step/speed/duration).
- Perbaikan: Mac tap menelan event buatan sendiri (loop `scroll.smooth`); Ctrl/Alt/Shift+scroll (zoom) melewati penghalusan; Mac memakai salinan event asli via `CGEventPostToPid` (ide dari Mos).

## UI
- Tab gear Settings (semua pengaturan), tab Tray dengan tile Files Tray + Send to other PC, jumlah file, Clear tray, tombol Add/Send dihapus (hanya drag & drop).
- Anathema (beranda): cover media (Windows), kalender mingguan, tombol Calibrate untuk Look to switch.
- Notifikasi (toast) yang menggantung dari pill; padding, teks berjalan.

## Look to switch (sesi terpisah)
- Pelacak kepala MediaPipe lokal, kalibrasi dua titik per komputer, dwell + histeresis, penundaan saat mengetik, takeback tanpa kamera Mac.

## Mac drop file
- Panel non-aktivasi tidak menerima drop; ditangani dengan deteksi native (pasteboard drag + `NSEvent pressedMouseButtons`), level jendela diturunkan sementara agar gambar drag terlihat.

## Belum selesai / terbuka
- Penandatanganan kode, audit eksternal enkripsi, kalender nyata, akurasi pendaratan pointer di Mac, uji installer/uninstall/auto-start.

## 2026-10-19 (malam)
- **Enkripsi lalu lintas** (`src/secure.js`): X25519 + HKDF + AES-256-GCM, bukti HMAC menggantikan PIN/token, anti-replay, lockout PIN setelah 5 salah. Protokol berubah: kedua komputer harus versi baru. 5 tes baru (`test/secure.test.js`).
- **Game guard**: pointer tersembunyi kini hanya dianggap game bila jendela depan memenuhi satu monitor penuh (Photoshop melukis tidak lagi memblokir); penyebabnya dicatat di log.
- **Kemasan**: ikon dan info versi ditulis ke .exe lewat `build/afterPack.js` (rcedit); hanya bahasa en-US/id, salinan MediaPipe ganda dan binary platform lain dibuang; kompresi maksimum.

## 2026-10-20
- **Pairing aman**: setelah kode PIN, kedua komputer menampilkan 6 angka yang harus cocok ("They match"); sesi pihak ketiga terdeteksi. Sambungan ulang dengan token tidak berubah. 4 tes baru (`test/pairing.test.js`).
- **Token terenkripsi** di disk (`safeStorage`: DPAPI Windows; Keychain Mac pada aplikasi terpasang).
- **Layar izin macOS** (`onboard.html`): tombol langsung ke Accessibility dan Input Monitoring, menutup sendiri saat izin diberikan.
- **Penanda "dikontrol"**: ikon link di pill berkedip kuning saat komputer ini sedang dikendalikan.
- Lisensi `UNLICENSED`, `THIRD-PARTY-NOTICES.md`, bagian About di Settings.
- Perintah uji di `control.cmd`: `keytest[:tombol,...]`, `keysink`, `filetest`, `pair:<host>:<kode>`, `sasyes`, `sasno`.

- **Pintasan keyboard**: halaman baru "Keyboard shortcuts" (rekam kombinasi tombol di keyboard komputer ini, lalu pilih aksi: menu radial, screenshot, desktop, atau kombinasi tombol lain). Tombol mouse juga bisa memilih "Keyboard shortcut..." untuk menekan kombinasi yang direkam. Daftar tersimpan per komputer dan berlaku untuk keyboard sendiri maupun keyboard komputer lain yang sedang mengontrol. `src/hotkeys.js` + `test/hotkeys.test.js`.
- **Screenshot ke folder**: Settings, Sharing: pilih satu folder; setiap screenshot (tombol screenshot A-tuls, pintasan sistem, atau yang diambil di komputer lain lewat clipboard bersama) disimpan otomatis sebagai PNG. Folder per komputer.
- **Animasi dan efek tepi**: warna bisa dipilih (General) dan disinkronkan antar komputer.
- **Hemat CPU**: pembaca media Windows kini satu proses PowerShell yang menetap (`media.ps1 -Loop`), bukan proses baru tiap 3 detik (sekitar 0,9% CPU seluruh PC jadi 0,007%); marquee teks lagu berhenti setelah 2 kali; jendela efek tepi hanya ada saat link tersambung; kamera Look to switch melambat saat kepala diam.
- **Daftar Recent**: satu komputer dengan dua id perangkat (folder pengaturan di-reset) tidak lagi muncul dua kali.
- **Auto connect** saat aplikasi mulai kini mati secara bawaan (Settings, Sharing).
- **Media Windows**: play/pause/next/prev lewat sesi media sistem (instan, bukan tombol media yang disuntik); tombol prev/next redup bila pemutar tidak punya.
- **Kamera Look to switch**: ditutup hanya setelah 10 menit tanpa pakai dan tidak pernah saat kalibrasi; kalibrasi yang terputus kini memberi pesan, bukan crash. Di Mac akselerasi perangkat keras kini aktif (tanpa WebGL pelacakan kepala gagal tiap frame dan kamera mati setelah 1 detik).
- **Media**: tombol back/forward melompat 10 detik dengan ikon "10" bila pemutar tidak punya lagu sebelumnya/berikutnya (pakem). Notifikasi "Screenshot saved" hanya muncul di komputer tempat screenshot diambil.
- **Satu kamera**: Look to switch hanya menyalakan kamera di komputer yang sedang dipakai (yang memegang mouse/keyboard, atau yang tidak didiamkan lebih lama); komputer lain menutup kameranya. Kalibrasi menyalakan kamera komputer tempat tombol Calibrate ditekan.
- **Settings, Pointer**: saklar Look to switch dipindah ke bawah baris Calibration (pakem). Kamera hanya satu: di komputer yang punya kalibrasi; bila keduanya terkalibrasi, kamera menetap dan pindah hanya bila komputer lain jelas lebih baru dipakai (pakem).
- **Mac screenshot**: pintasan bawaan macOS (Cmd+Shift+3/4/5) menyimpan file dan tidak menyentuh clipboard. Folder screenshot macOS kini dipantau: tiap file baru juga masuk clipboard (sehingga ikut ke komputer lain) dan tidak disimpan dua kali bila foldernya sama dengan folder A-tuls.
- **Home**: tombol kiri = Calibrate saat tersambung, Connect (membuka tab Link) saat belum; saklar Look to switch di bawahnya saat tersambung; tombol "Link a computer" dihapus (pakem).
- **Screenshot**: format PNG/JPG; batas ukuran folder (bawaan 500 MB) dengan pilihan hapus yang terlama (ke Trash) atau simpan; Mac: screenshot bawaan langsung ke clipboard selama A-tuls berjalan (pengaturan macOS dikembalikan saat keluar), file disimpan oleh A-tuls.
- Uji mandiri `shotself` (control.cmd): format JPG, batas ukuran (simpan/hapus terlama ke Trash), di PC dan Mac lulus.
- **Sinkron pengaturan**: pengaturan yang berarti sama di kedua komputer (warna animasi, animasi startup, efek tepi, edge resistance, game guard, Look to switch on/off, share clipboard, opsi screenshot) saling mengikuti saat terhubung; yang berubah paling akhir menang. Folder, tombol mouse, shortcut keyboard, scroll, menu radial dan kalibrasi tetap per komputer.
- Batas ukuran folder screenshot: minimal 1 MB (sebelumnya 50 MB menolak angka kecil tanpa pesan).
- **Kalibrasi → uji**: setelah kalibrasi tersimpan muncul "Calibration saved - Now look at <komputer lain> to try it"; begitu perpindahan pertama ke komputer lain berhasil dan animasi tepi layar selesai (sekitar 1,3 detik), komputer yang menjadi aktif menampilkan "Look to switch is ready".
- **Build produksi Windows**: installer 109 MB (`dist/A-tuls-1.0.0-win-x64.exe`). Ditemukan dan diperbaiki: build sebelumnya ikut memuat folder Referensi/ (proyek GPL/CC BY-NC), docs/ dan test/ karena daftar files per platform hanya berisi pola '!' ; kini setiap daftar diawali pola positif. Aplikasi terpasang hanya menjawab perintah control quit/restart/selftest/fx/splash.

## 2026-10-20 (malam): aplikasi yang macet tidak lagi membuat komputer harus di-restart
- **Penyebab masalah**: hook mouse/keyboard berjalan di proses utama. Bila proses itu membeku, input seluruh komputer ikut tersendat, dan satu thread yang tersangkut di Windows membuat proses tidak bisa dimatikan sama sekali (End task pun tidak) sambil menahan port 47800/47801 dan kunci instance; hanya restart Windows yang membersihkannya.
- **Watchdog** (`src/guardian.js`): proses terpisah yang menerima detak tiap detik. Bila 10 detik tanpa detak, aplikasi dimatikan saat itu juga (sebelum sempat tersangkut selamanya) dan salinan baru dijalankan; setelah 3 kali berturut-turut tidak dijalankan lagi. Terlewat tidur/suspend tidak dihitung. Teruji di PC dan Mac dengan membekukan thread utama (`hang:40000`), dan 4 tes otomatis.
- **Tetap bisa jalan walau ada sisa proses yang tersangkut** (`src/instance.js`): tiap instance mencatat process id; bila kunci instance dipegang proses yang sudah mati, dipakai folder data kedua ("A-tuls (2)") berisi salinan pengaturan beserta kunci penyimpan token (`Local State`), dan pengaturan yang lebih baru digabung kembali bila folder pertama bebas lagi. Tanpa catatan process id (versi lama) dicek apakah ada yang menjawab di port.
- **Port cadangan**: bila port 47800 dipakai, server memakai port berikutnya; port itu diumumkan lewat discovery dan diingat di daftar Recent, sehingga komputer lain menemukannya.
- **Tidak lagi memblokir thread utama**: ukuran fisik monitor Windows dibaca di latar belakang (dulu PowerShell sinkron sampai 5 detik per percobaan).
- **Masukan Gemini (hook dan macet)**: `SetCursorPos` tidak lagi dipanggil dari dalam callback hook mouse; dari sana kursor ditempatkan setelah callback kembali (`placeCursor`, 3 tes). Watchdog kini 6 detik (tadinya 10). Dicatat sebagai pekerjaan berikutnya: satu hook saja di Windows (buang uiohook-napi) dan hook di proses native terpisah dengan dead-man switch. Tidak diambil: `reuseAddr` pada soket TCP (membuka pembajakan port; port cadangan lebih aman) dan minidump otomatis lewat comsvcs.dll (teknik yang ditandai antivirus).
- **Nama baru: A-tuls** (dulu Island Link): semua teks di aplikasi, dokumen, paket (productName, appId app.atuls.desktop, nama installer), pembuat = Rizqaputra. Folder data pindah ke `A-tuls`; pengaturan, token, dan kalibrasi lama diambil alih otomatis pada start pertama. Pengenal internal (protokol, label kripto, tag log, nama berkas log) sengaja tidak diubah.
- **Izin macOS dan pembaruan dalam aplikasi:** jendela izin kini menandai Accessibility dan Input Monitoring satu per satu, memberi tahu "All set" begitu keduanya diizinkan, dan tidak muncul bila sudah diizinkan. Pengaturan > General punya baris Updates (cek, unduh, restart; di Mac tanpa tanda tangan tombolnya membuka halaman unduhan). Sumber pembaruan: rilis GitHub Rizqaputraaa/Atuls, jadi repo harus publik.
