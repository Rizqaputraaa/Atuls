# Prompt untuk Opus 5.5: tes 2 perangkat, audit, dan optimasi A-tuls

> Salin seluruh isi di bawah garis ini sebagai pesan pertama ke Claude Opus 5.5 (Claude Code), dengan folder kerja `E:\Projects\island-link`.

---

Kamu adalah insinyur senior yang memegang proyek **A-tuls** (folder `E:\Projects\island-link`). Tugasmu: **menguji aplikasi di dua komputer sungguhan, mengaudit kode, dan mengoptimasinya** supaya ringan (CPU, memori, RAM, baterai), **tanpa merusak fitur yang sudah berfungsi dan tanpa menambah bug baru.** Pemilik proyek berbicara bahasa Indonesia; jawab singkat dan polos dalam bahasa Indonesia.

## 1. Apa itu A-tuls

Aplikasi Electron 44 (Node) yang berbagi **mouse, keyboard, clipboard, screenshot, dan file** antara dua komputer lewat LAN terenkripsi: PC Windows "ANATHEMA" dan MacBook (Apple Silicon, ada notch). Antarmukanya sebuah **pill** di tengah atas layar (seperti Dynamic Island) yang membuka panel dengan tiga halaman: **Home** (jam, musik + lirik berwarna, kalender 4 hari, To Do), **Tray** (Files Tray + A-Drop), **Link** (hubungkan komputer, master, sisi layar). Ada jendela Settings, jendela Arrange screens, radial menu, color picker, animasi start-up, tepi layar berefek, kamera "Look to switch" (MediaPipe), dan pembaruan otomatis.

Kode utama (`src/`): `main.js` (proses utama, ±1900 baris), `link.js` (protokol, status mesin kontrol, hook mouse, ±1500 baris), `native.js` (koffi: Win32 dan CoreGraphics), `input-core.js` (uiohook + injeksi), `renderer/app.js` + `style.css` + `index.html` (UI pill), `settings.html`, `media.ps1` (now playing Windows, PowerShell yang hidup terus), `mixer.ps1` (volume per program Windows), `lyrics.js` (LRCLIB), `calendar.js` (iCal), `guardian.js` (pengawas yang menghidupkan lagi aplikasi yang macet), `instance.js`, `gaze*.js`. Dokumen: `docs/ARSITEKTUR.md`, `PANDUAN-DEVELOPER.md`, `CHANGELOG.md`, `ALUR-TES-AKHIR.md`.

## 2. Aturan yang TIDAK boleh dilanggar

1. **Jangan commit, push, buat tag, atau deploy** sebelum pemilik bilang. Kerjakan di cabang lokal baru (`git switch -c audit-opus`) dan buat commit kecil di cabang itu hanya bila diminta.
2. **Jangan mematikan proses A-tuls dengan paksa** (End task / `Stop-Process -Force`): pengawas akan menghidupkannya lagi dan bisa tersisa proses zombie. Keluar dengan benar lewat file `control.cmd` berisi `quit` (lihat bagian 4).
3. **Hanya satu salinan dev per komputer** pada satu waktu. Salinan ganda pernah membuat hook saling bentrok dan mouse mati.
4. **Mouse dan keyboard bisa terkunci.** Mode master mematikan mouse/keyboard komputer yang bukan master; tombol samping bisa "macet" di sistem. Selalu siapkan jalan keluar: kirim `master:off` lewat `control.cmd` (tidak butuh mouse), dan jangan mengetes kunci tanpa tahu cara melepasnya.
5. **Jangan tulis regex atau backslash lewat heredoc bash** (backslash hilang tanpa pesan): pakai alat Write atau Edit. Setelah mengedit file JS selalu `node --check`.
6. `koffi.proto('Nama...')` hanya boleh dibuat **sekali** per nama (yang kedua melempar "Duplicate type name"). Bangun callback native sekali, lalu nyalakan/matikan.
7. Jangan menyalin kode dari folder `Referensi/` (lisensi GPL/CC-NC). Font Gilroy (`src/assets/fonts`) tidak boleh masuk git.
8. Mac tidak punya node di PATH untuk ssh biasa: pakai `zsh -lc`.
9. Setiap perubahan: `npm test` (51 tes harus lulus), `node --check`, lalu perintah `selftest` di kedua komputer. Catat di `docs/CHANGELOG.md`.

## 3. Prinsip kerja: ukur dulu, ubah sedikit, ukur lagi

Untuk setiap optimasi: (a) ukur kondisi awal, (b) ubah **satu hal**, (c) ukur lagi, (d) jalankan seluruh daftar tes regresi (bagian 5) untuk area yang tersentuh, (e) simpan angka sebelum/sesudah. Jika angkanya tidak membaik jelas atau fitur tergelincir, **batalkan** perubahan itu. Tidak ada refactor besar tanpa alasan terukur. Jangan mengubah perilaku yang terlihat pengguna kecuali memang bug.

**Sasaran optimasi** (periksa, jangan asal percaya):
- CPU saat **diam** (tidak ada musik, tidak ada link aktif, panel tertutup): sasaran < 0,5 % satu inti, total semua proses A-tuls. Saat musik diputar + lirik: < 2 %.
- Memori: catat RSS tiap proses (utama, renderer pill, GPU, helper). Cari kebocoran dengan pemantauan 30 menit (naik terus = bocor).
- Proses anak: PowerShell `media.ps1`, `mixer.ps1`, helper clipboard, gaze/kamera. Pastikan kamera/MediaPipe, mixer, dan helper **berhenti** saat tidak dipakai.
- Pewaktu (`setInterval` / `setTimeout` / `requestAnimationFrame`): daftar semuanya, beri alasan tiap interval, ganti polling dengan peristiwa bila bisa, hentikan saat jendela tersembunyi atau game mode. Perhatikan khususnya: interval 16 ms pembaca tombol Mac saat mengontrol, interval 1 s `checkStuckButtons`, 400 ms kunci master Mac, 70 ms/animasi lirik, jam 1 s, poll media 2 s, `lyricTick` 250 ms, `watchGames` 1,5 s, pushHome 5 s.
- Renderer: `box-shadow`, `backdrop-filter`, `mask`, animasi CSS yang berjalan terus saat panel tertutup (pill tertutup tidak boleh membuat GPU sibuk), animasi `--p` pada `#island` (menginvalidasi seluruh subtree tiap frame: pertimbangkan memindahkannya ke elemen kecil).
- Ukuran paket dan waktu start (log `[island] window shown`), muat modul berat (MediaPipe, nut-js) secara malas.
- Log: `island-run.log` dan `island-verbose.log` berputar; pastikan penulisan log tidak bising saat diam.

**Cara mengukur**
- Windows: `Get-Process electron | Select Id,CPU,WS`, atau `Get-Counter '\Process(electron*)\% Processor Time'` selama 60 detik; atau jendela Diagnostics di Settings. Aplikasi menulis baris `health:` tiap menit ke `island-run.log` (cpu, mem, jumlah proses).
- Mac: `ps -o pid,pcpu,rss,command -p $(pgrep -f atuls-dev-data | tr '\n' ',')` atau `top -pid`.
- Ambil pengukuran pada keadaan: (1) start bersih dan diam 2 menit, (2) panel dibuka, (3) musik + lirik, (4) link aktif idle, (5) kirim file 200 MB, (6) master aktif, (7) game mode.

## 4. Menjalankan dan menguji di dua komputer

**PC (Windows, PowerShell)** — data dev terpisah supaya tidak mengganggu app terpasang:
```
cd E:\Projects\island-link
Start-Process .\node_modules\electron\dist\electron.exe -ArgumentList ".", "--user-data-dir=E:\Projects\island-link-dev-data"
```
Perintah uji dikirim dengan menulis satu baris ke `E:\Projects\island-link-dev-data\control.cmd` (dibaca tiap detik, hanya di mode dev). Log: `island-run.log`, `diag-summary.txt`, `diag.log` di folder yang sama.

**Mac** — cari IP lewat `Resolve-DnsName anathema-mac.local` (IP berubah-ubah). SSH: `ssh -i ~/.ssh/id_ed25519_mac -o StrictHostKeyChecking=accept-new user@<ip>`. Folder proyek di Mac: `/Users/user/MyWork/Dynamic Island/island-link`. Pasang kode: `tar -cf - src package.json | ssh ... "cd '<folder>' && tar -xf -"`; `zsh -lc "npm install"` bila dependensi berubah. Jalankan: `open -n node_modules/electron/dist/Electron.app --args '<folder>' --user-data-dir=/Users/user/atuls-dev-data`. `control.cmd` ada di `/Users/user/atuls-dev-data`. Log di folder yang sama. Aplikasi A-tuls terpasang di `/Applications/A-tuls.app` (v1.0.9) **jangan disentuh**. Izin Accessibility dan Input Monitoring untuk Electron di Mac sudah diberikan; jangan meminta ulang.

**Hubungkan keduanya:** PC: `connect:<ipMac>` (token tersimpan); bila "Wrong pairing code": `pair:<ipMac>:<PIN 6 digit dari log Mac>` lalu `sasyes` di kedua `control.cmd`.

**Perintah `control.cmd` (hanya dev):** `quit`, `restart`, `selftest`, `connect:ip`, `pair:ip:pin`, `sasyes`/`sasno`, `master:me|peer|off|auto`, `calibrated`, `enterpeer`/`leavepeer` (ambil/lepas kontrol komputer lain), `ovclick`, `assoctest`, `cursorpos`, `setpos:x,y`, `layoutdump`, `fakemedia:judul|artis|pos|panjang|Playing`, `fakemedia-off`, `faketransfer:nama.ext|MB`, `island:open|close`, `island:js:<kode>`, `island:eval:<ekspresi>` (hasil di log), `island:shot` (simpan `island-shot.png`; bisa dilihat dengan alat Read), `caltest:<url .ics>`, `splash`, `fx`. Ada pengalaman: screenshot layar Mac lewat ssh tidak diizinkan, gunakan `island:shot`.

## 5. Daftar tes regresi (semua harus tetap berfungsi)

Jalankan setelah tiap kelompok perubahan. Tandai lulus/gagal di laporan.

**A. Link dan pointer**
1. Pairing pertama (PIN + 6 angka konfirmasi) dan sambung ulang dari Recent tanpa kode.
2. Pointer menyeberang PC→Mac dan Mac→PC lewat tepi layar, mendarat tepat (≤ 1 px di Mac, ≤ 12 px di PC), jarak tepi/"edge resistance" bekerja.
3. **Klik, drag, klik kanan, scroll dari Mac ke PC** (pada Mac, tombol dibaca dari status perangkat keras karena hook/overlay tidak melaporkan klik saat mengontrol; jangan dihapus).
4. Keyboard dan shortcut mengikuti (Cmd↔Win), clipboard teks dan gambar, screenshot (kombinasi tombol samping belakang+depan di PC, Cmd+Shift+4 di Mac), notifikasi "Screenshot saved/taken".
5. Pergantian sisi layar (Left/Right/Above/Below) di Link mengubah Arrange screens dan tempat menyeberang di **kedua** komputer.
6. Putuskan sambungan: tidak ada tombol/modifier yang macet; kursor kembali muncul.

**B. Master mode (default hidup)**
7. Default: master = komputer pertama yang selesai kalibrasi; bila belum ada, PC Windows. Pilihan manual di Link menang. Ctrl+Alt+M mengambil alih. Panic (Ctrl+Alt+Shift+Esc) mematikan master di kedua komputer.
8. Komputer non-master: mouse, trackpad (kursor harus diam), keyboard, scroll mati total; mouse/keyboard master menggerakkan kedua komputer; non-master tidak pernah mengambil kontrol (tidak ada takeback). Kunci lepas bila link putus atau komputer lain diam 5 detik.
9. Halaman Home komputer non-master mengikuti master: To Do (edit dari mana pun), kalender, musik; tombol musik menggerakkan pemutar master.

**C. Home, Tray, UI**
10. Musik: judul/artis/cover, play/pause langsung berubah, lirik LRCLIB berwarna mengikuti lagu (tidak maju lebih awal), lirik di pill kecil dengan lebar mengikuti teks. Video non-lagu (Instagram, reel) **tidak** dapat lirik. "Ignore media from" di Settings menjaga lagu tetap tampil saat Instagram/TikTok jalan.
11. Kalender: tempel link .ics; 4 hari (50/100/70/50 %), titik warna dekorasi, legenda; To Do manual + hapus.
12. Tray: animasi masuk, hapus satu per satu dan semua dengan efek debu, kirim file/folder (folder dikirim sebagai .zip), kartu progres (jenis, persen, sisa waktu), notifikasi terkirim/diterima, tinggi panel mengikuti isi.
13. Pindah halaman: scroll mouse (atas-bawah) dan swipe trackpad (kiri-kanan, dua arah) dengan titik penanda.
14. Mixer volume per program (Windows) dan tiga volume sistem (Mac); slider volume utama.
15. Pill position Center/Right (Mac: tepat di kanan notch, tidak melompat saat hover), Hide in games, Ctrl+Alt+H, pill kecil tembus klik (klik tab browser di bawahnya), panel terbuka setelah pointer diam ±0,4 detik.
16. Suara: nada start-up, nada per jenis notifikasi, nada "impact" tiap pointer pindah, saklar dan volume di Settings. Mac memutar nada lewat `afplay`.
17. Settings: hanya satu scrollbar; semua halaman terbuka tanpa error (`selftest`).
18. Look to switch (kamera): hanya kamera komputer master yang aktif; kalibrasi dua langkah; berpindah saat melihat layar lain.
19. Mulai-ulang dan keluar bersih (`quit`): tidak ada proses yatim, tidak ada tombol macet, hook dilepas.

**D. Stabilitas jangka panjang**
20. Biarkan dua aplikasi terhubung 30 menit sambil memutar musik dan memindahkan pointer sesekali: tidak ada kenaikan memori terus-menerus, tidak ada "link ended", tidak ada baris `ERROR`/`Uncaught` baru di log.

## 6. Cara melaporkan

Buat `docs/LAPORAN-AUDIT-OPUS.md` berisi: (1) tabel ukuran sebelum/sesudah per keadaan, (2) daftar temuan (bug, risiko, kebocoran, kode mati) berurutan dari yang paling berat, tiap temuan dengan file:baris, bukti (log/angka), dan status (diperbaiki / tidak diubah karena risiko), (3) hasil daftar tes regresi di bagian 5 untuk **tiap** perubahan, (4) rekomendasi yang tidak kamu kerjakan beserta alasannya. Jangan mengklaim "sudah beres" bila belum diuji di kedua komputer; tulis apa yang tidak bisa kamu uji sendiri (misalnya klik fisik trackpad, kamera) dan minta pemilik mencobanya dengan langkah yang jelas.

## 7. Titik rawan yang sudah dikenal (jangan ulangi kesalahannya)

- **Tombol samping macet** di Windows (sistem mengira tombol "maju" masih ditekan) membuat klik mati walau kursor bergerak; ada pengawas `checkStuckButtons`. Jangan melemahkan jalur chord tombol samping tanpa tes.
- **Mac, kunci master**: menelan event mouse-move saja tidak membekukan kursor; yang bekerja adalah CGEventTap aktif (hanya event dengan pid 0 yang ditelan), `CGAssociateMouseAndMouseCursorPosition(false)`, dan `CGWarpMouseCursorPosition` kembali ke posisi terakhir yang diposting master. Tap dibuat sekali, hanya `CGEventTapEnable` yang diganti.
- **Pendeteksi game** (`SHQueryUserNotificationState`) salah mengira efek tepi layar sebagai game: ada jeda 5 detik setelah pointer berpindah dan syarat dua pembacaan berturut-turut.
- **Pill kecil tembus klik** memakai `setIgnoreMouseEvents(true)`; hover diukur dari posisi kursor (polling), bukan peristiwa jendela. Seret-lepas file ke pill harus tetap membuka panel.
- **Toast** tidak boleh lebih sempit dari pill di atasnya (lirik membuat pill melebar).
- Semua helper PowerShell dihentikan lewat penutupan stdin; jangan menambah helper baru tanpa jalur berhenti.
- **Beban terbesar yang diketahui** (periksa dulu): PowerShell media 2 s, animasi `--p` lirik pada `#island`, polling hardware 16 ms Mac hanya saat mengontrol, `setInterval` 1 s di banyak tempat, pembacaan clipboard (sudah dibatasi `GetClipboardSequenceNumber`).

Mulailah dengan: membaca `docs/ARSITEKTUR.md` dan `CHANGELOG.md` (30 entri terbawah), menjalankan `npm test`, menjalankan kedua salinan dev dan menghubungkannya, mengambil pengukuran dasar, lalu membuat rencana bertahap dan **minta persetujuan pemilik sebelum mengubah apa pun yang menyentuh input, hook, atau protokol link.**
