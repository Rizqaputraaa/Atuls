# Alur tes akhir (sebelum produksi)

Tujuan: menguji **semua menu dan fitur** satu per satu di PC (Windows) dan Mac, dengan bukti di log. Semua yang terjadi tercatat di satu file: **`island-run.log`**.

- PC: `%APPDATA%\A-tuls\island-run.log`
- Mac: `~/Library/Application Support/A-tuls/island-run.log`
- Cara menyalin: **Settings → Diagnostics → Copy run log** (400 baris terakhir), lalu tempel ke chat. **Copy diagnostics** (di halaman yang sama) memberi ringkasan akurasi/latensi pointer.

Yang dicatat otomatis: awal dan akhir aplikasi (termasuk "PREVIOUS RUN ENDED WITHOUT A CLEAN SHUTDOWN" kalau crash, lengkap dengan ringkasan laporan crash macOS), klik dan perpindahan tab (`ui: ...`), setiap perubahan pengaturan (`settings: ...`), koneksi, penyeberangan pointer (`event cross/entry/leave/takeback/state`), clipboard, file masuk/keluar, aksi tombol (`action ...`), menu radial (`radial menu ...`), color picker, glide scroll, dan semua error (`ERROR ...`, `UNCAUGHT EXCEPTION`).

**Aturan main:** jalankan satu bagian, lalu tulis "bagian X selesai" (atau tempel run log). Setelah semuanya hijau, lanjut ke produksi. Jangan lupa: setiap perubahan kode = aplikasi di kedua komputer direstart.

---

## Uji otomatis (tanpa menyentuh mouse)
Tulis `selftest` ke berkas perintah (`%APPDATA%\A-tuls\control.cmd` di PC, `~/Library/Application Support/A-tuls/control.cmd` di Mac). Aplikasi membuka jendela Settings tersembunyi, membuka sepuluh halamannya satu per satu, memeriksa error skrip, memeriksa elemen halaman pill dan memuat modul menu radial; hasilnya di run log (`selftest: ...`). Hasil 2026-10-19: PC dan Mac lulus (10/10 halaman, tanpa error skrip). Perintah lain: `quit` dan `restart` (penutupan rapi).

**Koneksi otomatis:** setelah salah satu komputer dimulai ulang atau koneksi putus, komputer dengan id lebih tinggi menyambung lagi sendiri ke perangkat yang pernah dipasangkan begitu ia terlihat di jaringan (`link: found ... again, connecting`). Koneksi yang diam 8 detik (kabel dicabut, Wi-Fi putus) ditutup otomatis (`link: no answer ... closing`). Tombol Disconnect dari pengguna mematikannya sampai koneksi berikutnya.

## 0. Persiapan
1. Mulai dari log bersih: tutup aplikasi di kedua komputer, hapus (atau ganti nama) `island-run.log`, jalankan lagi.
2. **Animasi start-up:** logo muncul di tengah atas layar, bersinar, lalu terbang ke pill; pill baru muncul setelah itu (±1,8 detik). *Log:* `==== start ...`.
3. Hanya ada **satu** instance di tiap komputer.

## 1. Pill dan panel
| Langkah | Hasil yang diharapkan | Bukti di log |
| --- | --- | --- |
| Hover ke pill, lepas, ulangi 10× | Panel membuka dan menutup halus, tanpa berkedip | `ui: island panel opened/closed` |
| Klik logo, Tray, Link | Tab berganti | `ui: island tab -> media/tray/link` |
| Klik gear (1× klik) | Jendela Settings terbuka di depan (PC dan Mac) | `ui: island gear clicked`, `settings window requested`, `ui: settings window opened on general` |
| Putar media (YouTube/Spotify) | Judul dan sampul tampil di halaman utama (Windows) | — |

## 2. Link dan koneksi
| Langkah | Hasil | Bukti |
| --- | --- | --- |
| Tab Link di kedua komputer: komputer lain muncul di *Nearby* | Ada nama, klik mengisi alamat | — |
| Masukkan kode 6 digit, Connect | Banner "connected", status Ready | `ui: link connect ...`, `link: connected` |
| Salah kode | Pesan "That code is not right" | `ERROR`/`denied` |
| Disconnect lalu pilih dari Recent | Sambung tanpa kode | `ui: link disconnect clicked`, `with the saved token` |

## 3. Pointer lintas layar
| Langkah | Hasil | Bukti |
| --- | --- | --- |
| Dorong pointer ke tepi menuju komputer lain | Pointer pindah, mendarat dekat titik yang sama | `event cross`, `event entry` (errPx kecil) |
| Gerakkan mouse fisik komputer yang dikendalikan | Kendali kembali | `event takeback` |
| Tahan klik (drag) di tepi | Tidak menyeberang | hitungan `held back` di diagnostik |
| Arrange screens | Jendela atur layar terbuka, posisi tersimpan | `ui: arrange screens clicked` |
| Settings → Pointer: edge resistance, game guard | Berpengaruh pada penyeberangan | `settings: edge resistance ...` |
| Look to switch: nyalakan, Calibrate, toleh | Banner kalibrasi jelas, pindah saat menoleh | `settings: look to switch on`, `event ...` |

## 4. Keyboard, clipboard, file
| Langkah | Hasil | Bukti |
| --- | --- | --- |
| Ketik di komputer yang dikendalikan | Teks muncul, Cmd↔Win benar | — |
| Salin teks/gambar di satu sisi, tempel di sisi lain | Tersalin | `clipboard -> text`, `clipboard <- text` |
| Matikan *Share clipboard*, salin | Tidak tersalin | `settings: share clipboard off` |
| Seret file ke pill (Tray) | Masuk daftar tray, jumlah file tampil | `file drag detected`, `drop` |
| Seret file ke tile Send / klik Send | File sampai di komputer lain, banner "File received/sent" | `ui: tray send file ...`, `transfer`, banner |
| Clear tray | Daftar kosong | `ui: tray cleared` |
| Win+Shift+S (PC mengendalikan Mac) | Screenshot Mac masuk clipboard | `action screenshot` |

## 5. Scroll
| Langkah | Hasil | Bukti |
| --- | --- | --- |
| Scroll roda mouse, Smooth on/off | Halus (PC: glide; Mac: glide bawaan) | `wheel glide (local)` (PC), `wheel scaled (native)` (Mac) |
| Scroll speed 50% / 200%, Reverse | Jarak dan arah berubah | `settings: scroll speed ...` |
| Tuning Step/Speed/Duration (PC) | Jarak dan lama glide berubah | `settings: scroll tuning ...` |
| Ctrl+scroll (zoom) | Zoom normal, tidak dihaluskan | tidak ada `glide` |
| Trackpad Mac | Tidak berubah, tidak patah | — |
| PC mengendalikan Mac lalu scroll | Mac scroll | `scroll.tx` / `scroll.rx` di diagnostik |

## 6. Tombol mouse dan menu radial
| Langkah | Hasil | Bukti |
| --- | --- | --- |
| Settings → Mouse buttons: thumb wheel → desktop kiri/kanan (Mac) | Desktop berpindah, sekali per putaran | `action desktopLeft/Right` |
| Back + Forward bersamaan | Aksi terpilih (default screenshot) | `action ... (trigger chord)` |
| Wheel press → Radial menu | Wheel muncul di bawah pointer, dengan logo | `radial menu opened` |
| Arahkan ke item Apps | Isi langsung tampil (tanpa klik) | — |
| Klik aplikasi / link / folder | Terbuka, ada animasi impact | `radial menu: open app "..."` |
| Hover Pick color: titik warna terakhir | Muncul, klik menyalin | — |
| Tekan trigger lagi atau klik logo tengah | Wheel menutup | `radial menu closed` |
| Settings → Radial: workspace, urutan, appearance | Tersimpan dan terlihat di wheel | `settings: radial menu saved (...)` |

## 7. Color picker
Ctrl+Alt+P (Mac: Cmd+Option+P) atau tombol Pick color → kaca pembesar live → klik: hex tersalin, toast, masuk riwayat. Esc/klik kanan membatalkan. *Bukti:* `picker: live`, `color picked #...`.

## 8. Settings (semua halaman)
General (start dengan komputer, animasi start-up), Pointer, Scrolling, Mouse buttons, Activation, Appearance, Wheel & workspaces, Color picker, Sharing, Diagnostics. Setiap perubahan harus tercatat sebagai `settings: ...` dan bertahan setelah aplikasi direstart.

## 9. Keselamatan
- **Ctrl+Alt+Shift+Esc** (Mac: Cmd+Option+Shift+Esc): melepas semua kendali, kursor muncul, tombol terlepas (`panic shortcut`).
- Tutup aplikasi lewat tray: log berakhir dengan `clean shutdown`.
- Mulai ulang setelah mati paksa: log memuat `PREVIOUS RUN ENDED WITHOUT A CLEAN SHUTDOWN` (wajar bila dimatikan paksa).

## 10. Produksi (setelah semua hijau)
1. Build installer Windows: `npm run dist:win`; Mac lewat GitHub Actions (`.github/workflows/release.yml`) atau `npm run dist:mac` di Mac.
2. Pasang bersih di komputer uji. **Start dengan komputer:** aktif otomatis pada instalasi pertama (Settings → General bisa mematikannya). Restart komputer → aplikasi harus berjalan sendiri dan memutar animasi logo.
3. Tanda tangan kode dan audit eksternal enkripsi (lihat `docs/KOMERSIAL.md`) sebelum dijual. Enkripsi lalu lintas sudah aktif: cek di log `link: connected`, dan komputer dengan versi lama tidak bisa tersambung (harus sama-sama diperbarui).
