# Pertanyaan untuk Gemini: aplikasi membeku dan menjadi proses zombie di Windows

Lampirkan file ini bersama `GEMINI-AUDIT-LENGKAP.md` (kode lengkap; yang paling relevan: `src/native.js` fungsi `installHook`, `src/link.js` fungsi `onWinMouseInner`, `src/input-core.js`, `src/input-child.js`, `src/input.js`, `src/main.js` bagian `startInput`, `startHookWatchdog`, `startGuardian`, `src/guardian.js`, `src/instance.js`). Jawab dalam bahasa Indonesia. Pisahkan fakta dari dugaan.

## Jawaban atas pertanyaanmu: hook apa yang dipakai

Tiga lapis, semuanya di proses utama Electron (thread UI Chromium), kecuali injeksi:

1. **Hook kustom lewat FFI `koffi`** (`src/native.js`, `installHook`): `SetWindowsHookExW(WH_KEYBOARD_LL)` dan `WH_MOUSE_LL` dengan callback JavaScript yang didaftarkan lewat `koffi.register`. Callback memutuskan **sinkron** apakah event ditelan (mengembalikan 1) atau diteruskan (`CallNextHookEx`). Keputusannya memakai state mesin pointer di `link.js` (`onWinMouseInner`): saat "controlling" gerak dan klik ditelan dan dikirim ke komputer lain; saat idle, sebagian tombol dipetakan ke aksi dan roda mouse dihaluskan.
2. **`uiohook-napi`** (pustaka pihak ketiga, libuiohook): thread hook sendiri; memberi aliran event gerak/tombol/roda/keys ke JavaScript. Jadi ada **dua set hook LL aktif di satu proses**.
3. **Injeksi**: klik, ketikan, dan scroll lewat `SendInput` di **proses anak** (`input-child.js`, `uIOhook.keyToggle` dan `nut-js`), karena `SendInput` dari thread pemilik hook pernah membekukan sistem input. Tetapi **`SetCursorPos`** (lewat `koffi`) dipanggil di proses utama, termasuk dari dalam callback hook mouse saat mem-"parkir" kursor ketika mengontrol komputer lain.

macOS memakai `CGEventTap` lewat `koffi` dengan pola serupa.

## Fakta tentang pembekuan (terjadi dua kali, dengan versi aplikasi yang berbeda)

- Task Manager: "Not Responding", CPU 0%. Log aplikasi (yang ditulis tiap beberapa detik oleh aktivitas biasa) berhenti total; tidak ada error, tidak ada exception. Aplikasi sedang idle (tidak sedang mengontrol komputer lain); aktivitas terakhir adalah event pemutar media dan klik UI biasa.
- Proses utama: 38 thread, 0 CPU. Status thread: 27 `Wait/UserRequest`, 7 `Wait/EventPairLow`, 4 `Wait/Unknown`. `EventPairLow` menunjukkan panggilan sinkron ke subsistem Win32 yang menunggu thread lain.
- `WM_CLOSE` (taskkill biasa) tidak diindahkan; mematikan proses renderer anaknya tidak membangunkannya; `Stop-Process -Force`: `HasExited=True` tetapi **satu thread tersisa** (`Wait/UserRequest`, start address 0, 16 detik CPU) yang tidak bisa dihentikan. Proses itu terus menahan soket `LISTENING` TCP 47800 dan UDP 47801 dan kunci instance Chromium (`lockfile`); hanya restart Windows yang membersihkannya.
- Dua pembekuan sebelumnya: salah satunya setelah mematikan paksa instance lain yang sedang memegang hook; yang kedua tanpa pemicu yang kami kenali.
- Penjaga baru (`guardian.js`) kini mematikan aplikasi setelah 10 detik tanpa detak dari event loop proses utama, dan menjalankan salinan baru; teruji dengan membekukan event loop dengan `while` sibuk (itu pembekuan user-mode yang mudah dimatikan, bukan yang tersangkut di kernel).

## Dugaan kami (mohon dinilai)

1. Dua hook LL di satu proses (`koffi` + `uiohook-napi`) bersama dengan `SetCursorPos` yang dipanggil dari dalam callback hook (yang memicu hook mouse lagi sebagai event "injected" di thread yang sama) bisa membuat panggilan masuk ke win32k saling menunggu dengan thread input mentah (RIT).
2. Thread utama Chromium tidak selalu memompa pesan cukup cepat untuk callback LL saat sedang sibuk (GC, IPC), sehingga Windows menunggu `LowLevelHooksTimeout` dan akhirnya ada tumpukan.
3. Penyebab lain di luar hook (mis. panggilan sinkron ke API lain, driver, atau interaksi dengan hook milik aplikasi lain seperti PowerToys, NVIDIA overlay, WingDeck yang terpasang).

## Pertanyaan

### A. Diagnosis
1. Bagaimana cara menangkap bukti **sebelum** proses menjadi zombie? Usulan kami: di `guardian.js`, sebelum `SIGKILL`, ambil minidump proses yang membeku (`rundll32 comsvcs.dll, MiniDump <pid> <file> full`) atau jalankan `procdump -h`. Apakah itu cukup untuk melihat stack thread utama dan thread yang menunggu `EventPair`? Alat apa (WinDbg Preview, `!analyze -hang`, `!locks`, `!thread`, ETW/WPR dengan profil Wait Analysis) yang paling cepat memberi jawaban, dan perintah persisnya?
2. Apakah status `Wait/EventPairLow` di banyak thread proses Electron normal (jadi tidak informatif), atau memang khas win32k yang menunggu hook? Bagaimana membandingkannya dengan instance yang sehat?
3. Mengapa satu thread bisa tidak mati setelah `TerminateProcess`, dan adakah cara dari user-mode yang sah untuk membebaskan soket/kunci yang ditahannya tanpa restart (mis. `SO_REUSEADDR`/`SO_EXCLUSIVEADDRUSE`, `NtTerminateThread`, menutup handle dari proses lain dengan `handle.exe`)? Kami tidak ingin trik berbahaya: kasus sebelumnya, uji `TerminateThread` dan `mouse_event` justru membuat injeksi input sistem macet.

### B. Arsitektur hook yang tahan macet
4. Apakah memasang `WH_MOUSE_LL` dan `WH_KEYBOARD_LL` di thread UI utama Electron memang dianggap salah desain? Rekomendasi: **proses native terpisah** (Rust, C#, atau C++ kecil) yang memegang hook dengan message loop sendiri, memutuskan "telan atau teruskan" dari **salinan state lokal** (tanpa menunggu JavaScript), dan berbicara dengan Electron lewat pipe bernama/IPC asinkron? Bagaimana mendesain **dead-man switch** (hook otomatis dilepas dan penangkapan dihentikan bila proses utama tidak berdetak 1 detik) agar proses utama yang macet tidak pernah membekukan input sistem?
5. Apakah `Raw Input` (`RegisterRawInputDevices`, `WM_INPUT`, `RIDEV_INPUTSINK`) cukup untuk **mengamati** gerak mouse saat idle (deteksi tepi layar, hover) sehingga hook LL hanya dipasang saat "controlling" (ketika memang harus menelan event)? Apa kekurangannya dibanding hook LL (mis. posisi tak terbatasi layar, input dari aplikasi elevated, game)?
6. Bolehkah memanggil `SetCursorPos` dari dalam callback hook mouse LL? Alternatif yang lebih aman untuk memarkir kursor saat mengontrol komputer lain (`ClipCursor` ke 1 piksel, kursor disembunyikan dan memakai delta relatif dari Raw Input, jendela overlay penangkap)?
7. Bagaimana menghindari dua hook LL di satu proses (`koffi` dan `uiohook-napi`)? Apakah lebih baik membuang `uiohook-napi` di Windows dan hanya memakai satu hook kustom yang kami kontrol, dengan event diteruskan ke JS lewat antrean tanpa kunci (SPSC ring buffer) sehingga callback hook tidak pernah menyentuh JavaScript?
8. `koffi.register` untuk callback hook: apakah callback itu dijalankan di thread UI Electron lewat message pump Chromium, dan apakah ada risiko khusus (GC, reentrancy, pemanggilan saat thread sedang di dalam panggilan FFI lain seperti `SetCursorPos`)?

### C. Mitigasi yang sudah ada
9. Nilai desain penjaga kami: deteksi 10 detik, `SIGKILL`, mulai ulang dengan folder data kedua dan port cadangan bila ada sisa zombie. Adakah celah (mis. false positive saat sleep atau beban tinggi, perlombaan dengan penutupan normal, perilaku bila `detached` fork gagal keluar dari Job Object, pengguna tanpa hak untuk mematikan prosesnya sendiri)? Apakah 10 detik terlalu lama bagi pengguna yang inputnya tersendat selama itu, dan bagaimana menurunkannya tanpa false positive?

## Format jawaban
Ringkasan (maks 8 baris), lalu tabel temuan (ID, area, temuan, dampak, saran, prioritas P0/P1/P2, usaha S/M/L, risiko regresi), urutan pengerjaan, kode atau perintah konkret untuk 3 temuan teratas, dan daftar fakta vs asumsi.
