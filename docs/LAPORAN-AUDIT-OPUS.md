# Laporan audit dan optimasi A-tuls (sementara, 2026-10-26)

Cabang: `audit-opus` (belum di-commit, belum di-deploy ke Mac).

## 1. Pengukuran (CPU = persen satu inti, rata-rata 30 detik)

| Keadaan | PC sebelum | PC sesudah | Mac |
| --- | --- | --- | --- |
| Diam, tidak terhubung, kamera mati | 1,09 %, private 371 MB | belum diukur ulang | 2,88 %, RSS 632 MB (main 1,86 %) |
| Terhubung, master PC, kamera PC hidup | 21,3 % (GPU 9,9 %, renderer kamera 6,8 %), private 804 MB | - | 25,2 % (main 12,5 %, GPU 8,8 %) |
| Musik + lirik, panel tertutup | **52,6 %** (renderer 34,4 %, GPU 17,8 %) | **11,3 %** (renderer 5,2 %, GPU 5,7 %) | belum diukur |

## 2. Perubahan yang sudah dibuat (PC sudah dites, Mac belum dipasang)

1. **Animasi warna lirik** (`renderer/app.js`): dulu berjalan di seluruh `#island`, sehingga tiap frame seluruh jendela digambar ulang. Sekarang hanya pada satu elemen yang tampil (baris di pill kecil, atau baris besar di panel), 24 langkah per detik. Musik + lirik di PC: 52,6 % menjadi 11,3 %.
2. **Jam** bangun sekali per menit (tepat pada pergantian menit), bukan tiap detik.
3. **Pemeriksa lirik** (250 ms) hanya berjalan saat lagu berlirik sedang diputar.
4. **Kirim Home ke komputer pengikut** hanya bila isinya berubah (paling lambat tiap 30 detik).
5. **diag-summary.txt** hanya ditulis bila ada yang berubah (dulu tiap 5 detik, juga saat diam).
6. **Log kunci master Mac** hanya ditulis bila angkanya berubah (dulu baris sama tiap 4 detik).
7. Perintah uji `procs` di `control.cmd`: daftar proses, jendela, CPU, dan memori.

`npm test` 51/51 lulus; halaman dimuat ulang tanpa error baru.

## 3. Temuan yang belum dikerjakan (perlu persetujuan: menyentuh input atau kamera)

1. **Mac main 1,9 % saat diam, 12,5 % saat terkunci master**: interval 16 ms pembaca tombol berjalan terus (padahal hanya perlu saat mengontrol), `pollMacDrop` tiap 40 ms, `pollHover` tiap 60 ms. Usul: nyalakan interval 16 ms hanya saat status `controlling`; polling drop hanya setelah tombol ditekan; hover 250 ms saat kursor jauh dari pill.
2. **Kamera Look to switch** (sekitar 17 % CPU+GPU di PC): usul fps adaptif (lebih rendah saat kepala diam) atau resolusi 320x240. Perlu uji akurasi.
3. **Jendela overlay di Windows** dibuat padahal tidak dipakai (Windows memakai hook): sekitar 70 MB. Usul: buat hanya di Mac.
4. **PowerShell media.ps1** memakai sekitar 77 MB private. Usul jangka panjang: helper kecil terkompilasi.

## 4. Belum diuji

Mac (perubahan belum dipasang), daftar tes regresi lengkap di kedua komputer, panel terbuka dengan lirik, kelancaran visual lirik 24 langkah per detik menurut mata pemilik.

## 5. Lanjutan (kedua komputer sudah dipasang dan dihitung)

Perubahan tambahan:
- **Windows tidak lagi membuat jendela overlay** (jendela layar penuh transparan yang hanya dipakai Mac; Windows menelan input di dalam hook). Dibuat hanya di Mac, atau di Windows bila hook gagal terpasang. Hemat 1 proses renderer (sekitar 70 MB private).
- **Mac:** pembaca tombol 16 ms hanya jalan saat Mac mengontrol komputer lain (dulu terus), polling drop file 100 ms saat tombol tidak ditekan (dulu 40 ms terus).
- **Isi warna lirik di pill kecil:** digerakkan pewaktu 10 kali per detik (tanpa animasi CSS); di panel 12 langkah per detik.

Pengukuran (CPU satu inti, 30 detik, musik + lirik, panel tertutup, link tidak aktif):

| | Sebelum | Sesudah |
| --- | --- | --- |
| PC | 52,6 % | 9-11 % |
| Mac | belum ada angka sebelum | 16,8-17,1 % (tanpa isi warna: 6,6 %) |

Catatan jujur: sisa 7-9 % di PC dan 10 % di Mac **bukan** dari kecepatan isi warna (2 Hz, 10 Hz, 24 Hz, 60 Hz hasilnya sama) dan bukan dari gradien teksnya (teks putih polos pun sama). Dugaan terkuat: lebar pill berubah tiap baris lirik (transisi lebar + `setShape` + ukuran jendela) dan transisi baris lirik di panel yang tertutup. Usul berikutnya: bulatkan lebar pill ke kelipatan 24 px dan hentikan transisi `.ll` saat panel tertutup, lalu ukur lagi. Pengukuran ini juga terganggu karena lagu yang diputar (YouTube di PC, Spotify di Mac) berganti-ganti.

`npm test` 51/51, `selftest` lulus di PC dan Mac, tidak ada `Uncaught` baru.

## 6. Hasil percobaan lebar pill dibulatkan (dibatalkan)

Diuji dengan lagu tetap (fakemedia), PC, 30 detik: lebar dibulatkan 24 px = 11,9 %, lebar tepat = 12,7 %. Selisih 0,8 poin masih dalam derau, jadi **pembulatan dibatalkan** (tidak ada untungnya, hanya mengubah tampilan). Transisi baris lirik dimatikan saat panel tertutup (tidak terlihat, tidak berbahaya) tetap dipakai.

Sisa beban (6-12 % saat lirik tampil di pill) tampaknya lantai dari desain: jendela pill transparan berukuran tetap 660x460 yang digambar ulang setiap kali teks di dalamnya berubah (isi warna 10x/detik), bukan dari fps isi warna atau perubahan lebar. Memperbaikinya berarti mengecilkan jendela transparan saat pill tertutup (kode lama menghindarinya karena pill berkedip saat jendela berubah ukuran): perlu persetujuan dan uji visual.

**Temuan baru:** jendela menu radial (`radial.html`, tersembunyi) tetap hidup setelah pernah dibuat: sekitar 109 MB di PC. Usul: hancurkan setelah 60 detik tidak dipakai dan buat lagi saat dibuka.

Keadaan diam sungguhan (tanpa lagu): PC GPU 0,4 %, renderer 0,2 %, main 0,1 %; Mac main 0,2 %, GPU 0,6 %, renderer 0,5 %.

## 7. Radial menu

Jendela `radial.html` (tersembunyi) dulu bertahan selamanya setelah dipakai sekali: sekitar 101-109 MB di PC. Sekarang: (a) saklar "Use the radial menu" di Settings > Activation (default hidup; mati = tidak ada yang dibuat, jendela dihancurkan), (b) bila hidup, jendela dihancurkan 60 detik setelah ditutup dan dibuat lagi saat dibuka. Diuji di PC: dibuka lalu ditutup membuat jendela (101 MB), 62 detik kemudian hilang; saat dimatikan, perintah buka tidak membuat jendela.
