# Rencana Komersial Island Link

Status: usulan awal (2026-10-19). Angka harga pasar di bawah **belum diverifikasi resmi**; cek halaman vendor sebelum memutuskan. Ini bukan nasihat hukum/pajak/keuangan.

## 1. Posisi produk

Produk ini menggabungkan tiga hal yang biasanya dijual terpisah:

1. **Berbagi mouse/keyboard lintas Windows ↔ Mac** (pesaing: Mouse Without Borders – gratis tapi Windows saja; ShareMouse – freemium; Synergy/Input Leap; Logitech Flow – butuh perangkat Logitech; Universal Control – hanya Apple).
2. **UI "island/notch"** (pesaing: NotchNook, Alcove, Boring Notch – semuanya Mac saja).
3. **Pindah komputer dengan menoleh** (belum ada pesaing langsung yang kutemukan) → diferensiasi utama.

Kalimat jualan yang jujur: *"Satu mouse dan keyboard untuk PC Windows dan Mac, dengan pill ala Dynamic Island, clipboard + file tray, dan pindah layar cukup dengan menoleh."* Pasar paling jelas: orang yang punya PC Windows **dan** MacBook di satu meja (developer, desainer, gamer + kerja).

## 2. Audit lisensi (wajib sebelum jual)

| Komponen | Lisensi | Boleh komersial? |
| --- | --- | --- |
| Electron | MIT | Ya |
| koffi | MIT | Ya |
| uiohook-napi | MIT | Ya |
| @nut-tree-fork/nut-js | Apache-2.0 | Ya (sertakan pemberitahuan lisensi) |
| ws | MIT | Ya |
| @mediapipe/tasks-vision + face_landmarker.task | Apache-2.0 (model Google; periksa kartu model) | Ya, sertakan atribusi; baca syarat model |
| LittleBigMouse (`Referensi/`) | **GPL-3.0** | **Tidak boleh disalin.** Hanya ide yang dipakai. |
| Mos (`Referensi/`) | **CC BY-NC 4.0 (non-komersial)** | **Tidak boleh disalin.** Hanya ide yang dipakai. |

Tindakan: (a) hapus folder `Referensi/` dari paket distribusi dan repo publik; (b) buat `THIRD-PARTY-NOTICES.md` (pakai `license-checker`); (c) ganti `"license": "ISC"` di `package.json` menjadi `UNLICENSED`/lisensi proprietary; (d) simpan catatan bahwa kode referensi tidak disalin (sudah ada di `Referensi/CATATAN-LittleBigMouse.md`).

Merek: jangan memakai "Dynamic Island" (merek Apple) atau "WingDeck" di nama/pemasaran. Cek ketersediaan nama "Island Link" (domain, merek dagang, App Store/Microsoft Store) sebelum branding.

## 3. Celah teknis yang HARUS ditutup sebelum rilis berbayar

1. **Enkripsi lalu lintas — SELESAI (perlu audit eksternal).** Semua lalu lintas antar komputer kini terenkripsi (`src/secure.js`): X25519 + HKDF-SHA256 + AES-256-GCM dengan penghitung berurutan (anti-replay), PIN/token tidak pernah dikirim — hanya bukti HMAC yang terikat ke satu sesi (anti man-in-the-middle). PIN dikunci 60 detik dan diganti setelah 5 kali salah. Pairing pertama kini memakai angka verifikasi (SAS) di kedua layar, dan token disimpan terenkripsi (`safeStorage`; di Mac aktif pada aplikasi terpasang). Sisa: audit eksternal, tanda tangan kode, hook macOS di proses anak. Catatan merek: hindari kata "Dynamic Island" di materi pemasaran (merek dagang Apple); lisensi paket `UNLICENSED`, daftar komponen di `THIRD-PARTY-NOTICES.md`.
2. **Otorisasi.** Token tersimpan harus berumur/dapat dicabut ("Forget device" sudah ada; tambahkan cabut dari sisi peer). Tolak koneksi dari luar subnet lokal secara default.
3. **Penandatanganan kode.** macOS: Apple Developer Program (±US$99/tahun), Developer ID + notarization, hardened runtime, entitlement kamera/Accessibility. Windows: sertifikat code-signing (OV/EV; atau Azure Trusted Signing) agar SmartScreen/Defender tidak menandai hook input sebagai malware.
4. **Pemasang & pembaruan otomatis.** `electron-builder` (NSIS/MSI untuk Windows, DMG/pkg universal untuk Mac) + `electron-updater` (kanal stable/beta).
5. **Stabilitas.** Perbaiki `--quit` yang tidak andal, SIGABRT uiohook saat shutdown, dan kebutuhan `kill -9` di Mac. Pastikan satu instance (single-instance lock bekerja).
6. **Crash reporting & telemetri opt-in** (Sentry atau serupa), tanpa mengirim isi ketikan/clipboard. Tulis kebijakan privasi: kamera diproses lokal, video tidak dikirim/disimpan.
7. **Kompatibilitas.** Uji: Windows 10/11, macOS 12–15+ (Apple sering mengubah izin Input Monitoring/Accessibility), Mac dengan/ tanpa notch, DPI campuran, banyak monitor, game *anti-cheat* (hook global bisa memicu deteksi; sediakan mode "jeda saat game").
8. **Aksesibilitas & bahasa.** Lokalisasi (minimal Inggris + Indonesia).
9. **Pengujian otomatis.** Saat ini hanya tes gaze; tambah tes protokol/state machine (link.js) dan layout (layout.js).

## 4. Model bisnis yang kurekomendasikan

**Freemium + Pro sekali bayar (dengan opsi langganan untuk fitur berbiaya server).**

| Paket | Isi | Harga usulan* |
| --- | --- | --- |
| **Free** | Pill + media, 1 perangkat tertaut, pointer + keyboard, clipboard teks, 1 tray terbatas (mis. 5 file) | Gratis |
| **Pro** | Semua fitur: file/screenshot tanpa batas, scroll tuning, Arrange multi-monitor, **Look to switch**, perangkat tak terbatas, tema | Sekali bayar US$19–29 (termasuk update 1 tahun), upgrade tahunan murah; atau US$2–3/bulan |
| **Cloud (nanti)** | Sinkron kalender Google/iCloud, relay di luar LAN, sinkron pengaturan | Langganan; hanya bila benar-benar ada biaya server |

*Patokan pasar (belum diverifikasi): NotchNook dilaporkan ±US$25 lisensi seumur hidup atau ±US$3/bulan ([Macworld](https://www.macworld.com/article/2406934/notfhnook-macbook-dynamic-island-widgets-files-tray.html), [iMore](https://www.imore.com/apps/mac-apps/this-dollar25-app-gives-my-macbook-pro-a-dynamic-island-and-it-was-worth-every-penny)); Mouse Without Borders gratis; ShareMouse freemium dengan lisensi sekali bayar menurut direktori ([AlternativeTo](https://alternativeto.net/software/sharemouse/)). Kamu berada di antara keduanya, jadi harga US$19–29 masuk akal bila stabil.

Alasan: (1) pesaing gratis ada (Mouse Without Borders, Input Leap) sehingga fitur dasar tidak bisa dipatok mahal; (2) pasar utilitas desktop terbiasa dengan lisensi seumur hidup; (3) langganan hanya diterima bila ada layanan berkelanjutan; (4) Look to switch adalah alasan membeli Pro.

### Penagihan & lisensi
- Pakai **merchant of record** (Paddle, Lemon Squeezy, atau Polar) supaya pajak/VAT global ditangani mereka dan pembayaran dari Indonesia bisa diterima; verifikasi syarat negara penjual dan metode pencairan (Wise/bank).
- Lisensi: kunci per perangkat (2–3 aktivasi), validasi online + cache offline 14–30 hari, trial 14 hari tanpa kartu. Jangan terlalu agresif anti-bajak; fokus kemudahan beli.
- Pasar distribusi: situs sendiri dulu (DMG/EXE bertanda tangan), Setapp (Mac) sebagai kanal tambahan. Mac App Store **tidak realistis** (sandbox melarang event tap/injeksi input global); Microsoft Store mungkin untuk Windows.

## 5. Peta jalan ke penjualan

1. **Fase A – Stabil & aman (2–4 minggu):** enkripsi + pairing aman, single-instance + quit andal, tes otomatis inti, perbaikan crash Mac.
2. **Fase B – Kemasan (1–2 minggu):** electron-builder, signing/notarization, auto-update, onboarding izin (layar panduan Accessibility/Input Monitoring/Kamera), ikon & identitas.
3. **Fase C – Beta tertutup (2–4 minggu):** 20–50 pengguna (komunitas dev/desainer, Reddit r/macapps & r/pcmasterrace, X). Kumpulkan diagnostik (tombol Copy diagnostics sudah ada). Ukur akurasi Look to switch di berbagai wajah/kamera.
4. **Fase D – Rilis berbayar:** situs landing + video demo (lintas OS & menoleh adalah materi viral), dokumentasi, dukungan email, kebijakan privasi, EULA.
5. **Fase E – Setelah rilis:** kalender nyata, media di Mac (Spotify/Music API), lebih dari 2 perangkat, Linux, relay jarak jauh.

## 6. Risiko utama

| Risiko | Mitigasi |
| --- | --- |
| Pesaing gratis (Mouse Without Borders, Input Leap) | Diferensiasi: lintas OS + UI + Look to switch; Free tier cukup baik untuk menarik |
| Perubahan izin macOS merusak injeksi/tap | Uji di beta macOS tiap rilis; modul `native.js` terisolasi |
| Antivirus/anti-cheat menandai hook | Code signing, dokumentasi, mode jeda untuk game, kirim sampel ke Microsoft untuk allowlist |
| Keamanan (keylogging lewat jaringan) | Enkripsi wajib, pairing aman, audit eksternal ringan sebelum rilis |
| Beban dukungan (izin, jaringan, firewall) | Halaman diagnostik otomatis, FAQ, deteksi port 47800 terblokir |
| Klaim privasi kamera | Proses lokal, indikator kamera di pill (sudah ada), default mati (sudah) |
| Lisensi referensi (GPL/CC BY-NC) | Jangan salin kode; hapus `Referensi/` dari distribusi |

## 7. Keputusan yang perlu darimu

1. Nama produk final (cek merek & domain).
2. Harga & model (usulan: Free + Pro sekali bayar).
3. Apakah kalender/media Mac masuk versi 1.0 atau setelahnya.
4. Anggaran: Apple Developer (~US$99/th), sertifikat Windows (~US$100–400/th, atau Azure Trusted Signing), domain/hosting, merchant fee (±5% + biaya tetap).
