# Panduan Developer

## Menjalankan

```bash
cd E:\Projects\island-link
npm install
npm start          # PC
npm test           # unit test (gaze, link-gaze)
```

Variabel lingkungan: `ISLAND_PORT` (default 47800), `ISLAND_AUTOCONNECT` (untuk uji).

## Mac (lewat SSH)

- Host: `user@192.168.1.4`, kunci `~/.ssh/id_ed25519_mac`. Folder: `/Users/user/MyWork/Dynamic Island/island-link`.
- Salin file: `Get-Content file -Raw | ssh ... "cat > '<dir>/src/file'"` (stdin; hindari kutip bersarang).
- Restart: `pkill -9 -f 'island-link/node_modules/electron/dist/Electron.app'`, lalu
  `open -n --stdout /tmp/island.out --stderr /tmp/island.err -a '<dir>/node_modules/electron/dist/Electron.app' --args '<dir>'`.
- Log: `/tmp/island.out`. Pastikan hanya **satu** proses `Contents/MacOS/Electron /Users...`.
- `osascript`/`screencapture` lewat SSH tidak berguna (izin Automation / Screen Recording).

## Restart PC dengan aman

1. Tutup lewat menu tray (disarankan). `electron . --quit` tidak andal dan dapat menambah instance.
2. Jika terpaksa: hentikan semua `electron.exe` yang `CommandLine` memuat `island-link`, tunggu 5 detik, lalu jalankan satu instance: `Start-Process .\node_modules\electron\dist\electron.exe -ArgumentList '.' -WorkingDirectory E:\Projects\island-link -WindowStyle Hidden`.
3. Cek jumlah proses utama (tanpa `--type`): aplikasi + `input-child.js` = normal.

## Diagnostik

Settings → Copy diagnostics. Isi: temuan otomatis, pengukuran (RTT, jeda gerakan, error pendaratan px/mm, lag smoothing), hitungan (`entry`, `leave`, `takeback`, `wall`, `scroll.tx/rx/smooth/wheel/pad/tapoff`, `block.freelook`, dll.), dan 12 peristiwa terakhir. Tempel dari kedua komputer untuk membandingkan.

## Pola debugging yang berhasil

- Bandingkan hitungan `scroll.tx` (PC) dengan `scroll.rx` (Mac) untuk menemukan di mana pesan hilang.
- `scroll.smooth` jauh lebih besar dari `scroll.rx` = event buatan sendiri tertangkap tap (loop).
- Pada Mac, uji dengan aplikasi nyata dan pengguna; harness Electron tidak menerima scroll sintetis.
- Jangan menjalankan uji stres input di PC pengguna (bisa mengunci input sistem).

## Konvensi

- Satu file satu tanggung jawab; perilaku protokol di `link.js`, sentuhan OS di `native.js`.
- Pengaturan per-perangkat disimpan di `store` dan tidak dikirim ke peer.
- Komentar menjelaskan *mengapa*, bukan *apa*.
- Referensi (`Referensi/`) hanya untuk ide; lisensinya (GPL-3.0, CC BY-NC) melarang menyalin kode ke produk komersial.
