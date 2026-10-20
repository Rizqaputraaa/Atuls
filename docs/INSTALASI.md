# Instalasi Island Link (tanpa App Store)

Aplikasi dibagikan lewat **GitHub Releases** (atau situs pribadi). Belum ditandatangani, jadi sistem akan memberi peringatan satu kali.

## Windows 10/11
1. Unduh `Island-Link-<versi>-win-x64.exe` dari halaman Releases.
2. Jalankan. Jika muncul **"Windows protected your PC"**: klik **More info → Run anyway** (muncul karena belum ada sertifikat code-signing).
3. Pilih folder, selesai. Island Link muncul di tengah atas layar.
4. Firewall: izinkan koneksi jaringan privat saat diminta (port TCP 47800).

## macOS 12+
1. Unduh `Island-Link-<versi>-mac-arm64.dmg` (Apple Silicon) atau `-x64.dmg` (Intel).
2. Buka DMG, seret **Island Link** ke **Applications**.
3. Pertama kali dibuka macOS akan menolak aplikasi yang belum dinotarisasi. Pilih salah satu:
   - klik kanan aplikasi → **Open** → **Open**, atau
   - jalankan di Terminal: `xattr -cr "/Applications/Island Link.app"`
4. Beri izin di **System Settings → Privacy & Security**: **Accessibility**, **Input Monitoring** (dan **Camera** bila memakai Look to switch). Setelah memberi izin, buka ulang aplikasi.

## Menghubungkan dua komputer
1. Buka Island Link di kedua komputer, di jaringan yang sama (Windows ↔ Mac, Mac ↔ Mac, atau Windows ↔ Windows).
2. Di komputer A: tab **Link** → catat IP dan kode 6 digit.
3. Di komputer B: tab **Link** → isi IP dan kode A → **Connect**. Berikutnya cukup pilih dari **Recent devices**.
4. **Arrange screens** untuk mengatur posisi layar.

## Memperbarui
Unduh versi baru dari Releases dan pasang di atas yang lama (pengaturan tetap tersimpan). Pembaruan otomatis menyusul.

## Membuat rilis (untuk pengembang)
1. Buat repo GitHub, lalu dari folder proyek: `git init`, `git add .`, `git commit -m "first"`, `git remote add origin <url>`, `git push -u origin main`.
2. Naikkan `version` di `package.json`, lalu `git tag v1.0.0 && git push origin v1.0.0`.
3. Workflow `.github/workflows/release.yml` membangun `.exe` (Windows) dan `.dmg` (Mac arm64 + Intel) dan melampirkannya di Release.
4. Build lokal: `npm run dist:win` (hasil di `dist/`). `dist:mac` harus dijalankan di Mac.
