# Brief optimasi untuk Gemini: Island Link

Tolong bertindak sebagai insinyur performa dan arsitektur desktop yang berpengalaman (Electron, Node native addons, API input Windows dan macOS). Tujuan: **membuat Island Link lebih ringan (CPU, memori, baterai, ukuran paket, latensi) tanpa mengurangi fitur atau menambah regresi.**

Cara pakai: lampirkan file ini bersama `GEMINI-AUDIT-LENGKAP.md` (berisi seluruh kode sumber di Bagian E, arsitektur di Bagian B, dan riwayat di Bagian D). Jawab dalam bahasa Indonesia. Dasarkan jawaban pada kode yang ada; kalau kamu mengasumsikan sesuatu, katakan itu asumsi. Jangan menyarankan menulis ulang dari awal.

---

## 1. Produk singkat

Island Link: aplikasi Electron 44 untuk Windows 10/11 dan macOS. Pill ala Dynamic Island di tepi atas layar, plus berbagi mouse, keyboard, clipboard, file, screenshot antara dua komputer di LAN (WebSocket terenkripsi, port 47800; penemuan UDP 47801). Pointer pindah komputer saat digeser keluar tepi layar, atau saat pengguna menoleh (kamera lokal, MediaPipe). Ada menu radial, color picker, efek tepi layar, animasi startup, dan pintasan keyboard yang bisa direkam. Akan dijual (bukan lewat App Store). Aplikasi berjalan terus di latar belakang sepanjang hari, jadi **biaya saat idle adalah masalah utama**.

## 2. Hasil pengukuran (PC Windows 11, 16 inti logis, 2 monitor, aplikasi mode pengembangan)

CPU diukur sebagai persen dari seluruh mesin, selama 12 sampai 15 detik, per proses (lihat skrip di bawah).

| Keadaan | CPU total | Memori (working set) | Proses |
|---|---|---|---|
| Idle, link tidak aktif, **sebelum** perbaikan | sekitar 1,8% | 904 MB | 7 |
| Idle, link tidak aktif, **sesudah** perbaikan | sekitar 0,15% | 661 MB | 5 |
| Link aktif + Look to switch (kamera) menyala | sekitar 1,5 sampai 1,8% | sekitar 1.300 MB | 9 |

Rincian keadaan terakhir (link aktif + kamera): gpu-process 0,6 sampai 0,9%, renderer halaman kamera 0,4%, VideoCaptureService 0,2%, proses utama 0,17%.

Temuan yang sudah diperbaiki, sebagai konteks (jangan diulang, tapi beri tahu kalau ada pola serupa):
- Animasi CSS `marquee` tanpa henti pada teks lagu di pill (elemen berisi `mask-image`) menghabiskan sekitar 1,7% CPU lewat proses GPU. Sekarang dibatasi 2 iterasi.
- Tiga jendela efek tepi layar (transparan, tersembunyi, dibuat di awal) memakai sekitar 110 MB per jendela. Sekarang hanya dibuat saat link tersambung.
- Pembacaan kamera 24 fps terus-menerus. Sekarang turun ke 10 fps saat kepala diam lebih dari 1,5 detik atau tidak ada wajah. Menurunkan resolusi kamera 640x480 ke 320x240 hanya menghemat sekitar 4%, jadi dibatalkan.

Ukuran paket Windows (electron-builder, NSIS): sekitar 146 MB installer, 414 MB terpasang. Sebagian besar adalah Electron itu sendiri (`Island Link.exe` 236 MB).

Skrip pengukuran yang dipakai (PowerShell): ambil `Get-Process` semua `electron.exe` milik aplikasi, catat `CPU` (detik prosesor kumulatif) di awal dan di akhir interval, bagi dengan lama interval dan jumlah inti, kelompokkan menurut `--type=` pada command line.

## 3. Arsitektur yang relevan dengan performa

- **Proses utama (`src/main.js`, `src/link.js`, `src/native.js`)**: state machine pointer, protokol, hook input.
- **Windows**: hook global lewat `koffi` (`WH_KEYBOARD_LL`, `WH_MOUSE_LL`) yang memanggil callback JavaScript untuk **setiap** event mouse/keyboard, ditambah `uiohook-napi` yang memberi event gerak mouse ke JS. Injeksi input dilakukan di proses anak (`src/input-child.js`) karena `SendInput` dari thread yang memegang hook pernah membuat sistem input macet.
- **macOS**: `CGEventTap` lewat `koffi` untuk scroll dan klik; `uiohook-napi` untuk gerak mouse; media "now playing" lewat skrip Perl (`mediaremote-adapter`) yang berjalan terus.
- **Polling di proses utama** (lihat Bagian E, `main.js`): hover pill tiap 60 ms (`pollHover`), deteksi drag file di Mac tiap 40 ms, pemantau hook tiap 2 detik (Windows), pemantau file perintah tiap 1 detik, sambung ulang otomatis tiap 8 detik, ringkasan diagnostik ditulis ke disk tiap 5 detik, heartbeat link tiap 2 detik, pembacaan clipboard tiap 800 ms (juga saat link tidak aktif, bila fitur simpan screenshot menyala), penemuan UDP tiap 4 detik.
- **Jendela (renderer)**: pill (transparan, 460x380 tetap, bentuknya dipotong dengan `setShape` di Windows), jendela overlay, jendela kamera tersembunyi (MediaPipe WASM/WebGL, hanya saat link aktif), jendela efek tepi layar (satu per monitor), menu radial, Settings. Jam di pill diperbarui tiap detik dan kalender tiap menit.
- **Link**: satu koneksi WebSocket; gerak pointer dikelompokkan sekitar 6 ms per paket; setiap frame dienkripsi AES-256-GCM (`src/secure.js`). Latensi putaran di LAN rata-rata 3 sampai 20 ms, p95 5 sampai 100 ms (Wi-Fi tidak stabil).
- **Scroll**: Windows memakai penghalusan sendiri (`smooth.js`, timer 4 ms saat aktif); Mac menskalakan event scroll asli di `CGEventTap`.

## 4. Batasan yang tidak boleh dilanggar

- Jangan mematikan fitur yang sudah berfungsi. Perubahan yang mengubah perilaku harus punya pengaman atau pilihan di Settings.
- Hook input harus tetap andal. Pelajaran yang sudah mahal: mematikan paksa proses Windows yang memegang hook pernah membuatnya tidak bisa dimatikan sampai komputer di-restart; `SendInput` dari thread hook pernah membekukan input sistem. Jangan menyarankan trik yang berisiko ke arah itu.
- Satu pengembang. Saran harus realistis: urutkan menurut hasil dibanding usaha.
- Tidak ada server perantara; semua lokal.

## 5. Pertanyaan (jawab satu per satu; beri prioritas P0/P1/P2, taksiran hasil, dan taksiran usaha S/M/L)

### A. CPU dan baterai saat idle
1. Dari daftar polling di Bagian 3, mana yang paling layak diganti dengan mekanisme berbasis event atau diperlambat secara adaptif? Beri nilai interval yang kamu sarankan dan alasannya. Khusus `pollHover` (60 ms), apakah lebih baik memakai event gerak mouse dari hook yang sudah ada?
2. Callback hook Windows lewat `koffi` dan event `uiohook-napi` membangunkan JavaScript pada setiap gerak mouse (mouse 1000 Hz berarti sampai 1000 panggilan per detik). Apa cara paling aman untuk mengurangi biaya ini saat link tidak aktif dan tidak ada tombol yang dipetakan (mis. lewati event gerak lebih awal, pisahkan hook klik dari hook gerak, atau pasang hook gerak hanya saat dibutuhkan)? Apa risikonya bagi deteksi tepi layar?
3. Skrip Perl `mediaremote-adapter` dan pembaca media Windows (`media.ps1`): apakah polling atau prosesnya bisa dihentikan saat pill tidak terlihat atau panel tertutup? Sarankan strategi.
4. Efek CSS di renderer: apa lagi yang biasanya membuat proses GPU Chromium aktif terus pada jendela transparan di Windows (mis. `mask-image`, `backdrop-filter`, layer besar 460x380, `setShape`)? Apakah jendela transparan yang tetap ada ini sendiri mahal bagi DWM walau isinya statis, dan adakah cara lebih murah (ukuran jendela dinamis, `backgroundThrottling`, menyembunyikan saat tidak dipakai)?
5. Fitur kamera: bagaimana menurunkan biaya Look to switch selain mengurangi fps? Apakah delegasi GPU atau CPU lebih hemat untuk model Face Landmarker, apakah `outputFacialTransformationMatrixes` bisa diganti model yang lebih ringan, dan apakah sebaiknya kamera dimatikan otomatis bila layar terkunci, tidak ada gerak mouse beberapa menit, atau baterai rendah?

### B. Memori dan jumlah proses
6. Proses Electron saat idle: 5 sampai 9 proses (utama, GPU, network, beberapa renderer). Mana yang bisa dihilangkan atau dibuat malas (lazy): jendela overlay, jendela radial, jendela Settings, jendela kamera? Apakah satu renderer bersama untuk beberapa jendela kecil masuk akal?
7. Bagaimana menekan memori renderer pill dan Settings (mis. memuat Settings hanya saat dibuka lalu menghancurkannya saat ditutup)? Adakah flag Chromium yang aman untuk aplikasi kecil seperti ini (mis. `--disable-features=...`, `--js-flags=--max-old-space-size`, mematikan `spellcheck`, `v8CacheOptions`)?
8. `uiohook-napi`, `nut-js`, `jimp`, `koffi` ikut terpasang dengan banyak dependensi. Mana yang bisa dibuang, diganti dengan `koffi` langsung, atau dimuat malas, untuk mengurangi ukuran dan waktu startup?

### C. Ukuran paket dan startup
9. Installer 146 MB. Apa yang masih bisa dipangkas dengan aman (asar dengan `asarUnpack` untuk file native, hapus locale, `vk_swiftshader.dll`, `LICENSES.chromium.html` yang 19 MB, kompresi, memilih Electron yang lebih kecil)? Apa risiko menyalakan `asar` untuk aplikasi yang memanggil skrip `.ps1` dan modul native?
10. Waktu startup: animasi logo, pemuatan modul native, pembuatan jendela. Bagaimana mengurutkan pemuatan supaya pill muncul lebih cepat? Apakah snapshot V8 atau `v8-compile-cache` layak?

### D. Jaringan dan latensi
11. Gerak pointer dikelompokkan 6 ms lewat WebSocket/TCP. Dengan Wi-Fi yang kadang melonjak (p95 sampai 100 ms), apa perbaikan paling berguna: `TCP_NODELAY` eksplisit, menurunkan frekuensi, prediksi/interpolasi di sisi penerima, atau pemisahan kanal gerak (UDP berseri) dari kanal klik/keyboard yang harus andal? Beri rekomendasi dan harga implementasinya.
12. Enkripsi AES-GCM per frame dengan `Buffer.concat` untuk setiap paket kecil: apakah ini hotspot yang berarti pada 160 sampai 1000 paket per detik? Sarankan optimasi (buffer pool, batching, `crypto.createCipheriv` yang dipakai ulang).

### E. Kualitas kode yang memengaruhi performa
13. `link.js` (sekitar 1.300 baris) berada di jalur panas (setiap event gerak). Tunjukkan alokasi objek atau pekerjaan berulang yang tidak perlu pada jalur itu (mis. `L.dispAt`, `L.toPlane`, `JSON.stringify` per paket) dan cara mengurangi tekanan GC.
14. Diagnostik (`diag.js`) menulis ringkasan tiap 5 detik dan mencatat event; apakah ini perlu dimatikan atau dijarangkan saat tidak ada masalah?

### F. Pengukuran
15. Rancang cara pengukuran yang bisa diulang (skrip, metrik, kondisi uji) untuk memverifikasi setiap optimasi di Windows dan macOS (CPU per proses, memori, wakeups/detik, dampak baterai di MacBook, waktu startup). Alat apa yang kamu sarankan (Windows Performance Recorder, `typeperf`, Instruments Energy, `powermetrics`)?

## 6. Format jawaban yang diminta

1. **Ringkasan eksekutif** (maksimal 8 baris): tiga optimasi dengan hasil terbesar.
2. **Tabel temuan**: ID, area, temuan (kutip file dan fungsi), dampak (kira-kira berapa persen CPU/MB/ms), saran konkret, prioritas P0/P1/P2, usaha S/M/L, risiko regresi (rendah/sedang/tinggi).
3. **Urutan pengerjaan** yang disarankan, dimulai dari yang berhasil terbesar dengan risiko terkecil.
4. **Kode atau diff** singkat untuk 3 temuan teratas (jangan menulis ulang seluruh file).
5. **Fakta vs asumsi**: pisahkan apa yang kamu lihat langsung di kode dari yang kamu duga.
