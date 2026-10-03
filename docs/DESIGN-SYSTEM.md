# Supplier-ID Design System v2

Sumber: tiga gambar referensi yang diunggah Erza (4 Okt 2026). Tidak ada file Figma/font/logo resmi Supplier-ID; token di bawah **diturunkan** dari gambar, bukan reproduksi aset. Referensi pola publik yang dipakai sebagai acuan (diakses 4 Okt 2026, tidak memakai aset): Shopee (mobile: pencarian di atas, kartu produk padat, navigasi bawah 5 tab, timeline pesanan), pola "task inbox" ala Linear/Jira (kartu tugas berorientasi aksi, tenggat & status), tabel operasional ala Retool/Airtable (sticky header, filter, ekspor).

## Token (`web/src/tokens.css`)
| Token | Nilai | Sumber |
|---|---|---|
| `--bg` / `--surface-2` | `#f7f6f1` / `#fbfaf6` | My Farm `#FBFAF6` (terukur) |
| `--bg-2` / `--line` | `#efede6` / `#e4e1d7` | My Farm `#E2D6B7` dicerahkan [est] |
| `--text` | `#1f2a24` | My Farm `#090808` + nada hijau [est] |
| `--navy` | `#282445` | Infografis (terukur) |
| `--brand` | `#2f6b4f` | diturunkan dari My Farm `#506B5D`/`#6CA688` agar kontras AA ≥4.5 pada putih [est] |
| `--accent` | `#df9c6c` | My Farm (terukur); Portu salmon `#ED9C7A` serupa |
| `--danger` | `#c9533f` | Infografis koral `#EB7867` digelapkan untuk kontras [est] |
| `--info` | `#5e6a94` | Infografis (terukur) |
| `--radius-lg` | 16 px | Portu: kartu radius ±16–24 px [est] |
| `--radius-pill` | 999 px | My Farm: tombol pil |
| `--shadow` | `0 6px 18px rgba(31,42,36,.07)` | Portu: bayangan lembut [est] |
| Font | Inter (fallback system-ui) | Font referensi tidak teridentifikasi dari gambar [ASUMSI]; Poppins/Montserrat kandidat bila Erza memberi file font |
| Skala tipe | 11/12/14/16/20/28, hero `clamp(32px,6vw,56px)` | My Farm headline besar bold+regular |
| Spasi | grid 4 px; gutter 16 (mobile) / 24 (desktop) | [est] |
| Sentuh | min 44 px | WCAG 2.5.5 |

## Komponen reusable (web, dipakai juga di APK Android via Capacitor)
- `PublicLayout` (top nav + pencarian + bottom nav 5 tab di ≤768 px + banner offline), `ProductCard`, `ProductSkeleton`, `EmptyState`, `ErrorState`.
- `Card`, `Stat`, `Badge` (warna + teks, bukan warna saja), `Alert`, `Field`, `AsyncButton` (konfirmasi + error inline), `Timeline`, `EvidenceGallery`, `Tabs`.
- `task-card` (inbox mitra & manifest kurir): kode tahap, judul, tenggat/sisa waktu, status; merah = terlambat, kuning = perlu tindakan.
- `OpsTable` (admin): search, sort, pagination, sticky header, ekspor CSV, kartu di layar sempit.
- `Scanner` (kamera BarcodeDetector bila ada + input manual), `scan-result` OK/REJECTED selalu dengan teks alasan.
- Label: `.label-a4` (100×70 mm, QR + Code 128), `.label-thermal` (72 mm). Cetak lewat dialog browser (PDF).

## State UI yang diimplementasikan
Loading/skeleton (katalog, keranjang, detail), empty (keranjang, inbox, manifest, tiket), error + coba lagi, sukses (alert), offline (banner + SW cache GET), permission denied (403 → pesan izin peran), session expired (401 → token dihapus, kembali ke login dengan `?next=`).

## Aksesibilitas
Fokus terlihat (`:focus-visible` outline aksen), label pada input/ikon (`aria-label`), tab chips `role=tablist`, kontras teks ≥4.5:1 pada token utama, ukuran sentuh 44 px pada CTA utama & navigasi bawah, zoom teks tidak memotong layout (grid fluid). Pengujian screen reader & perangkat nyata belum dilakukan (butuh perangkat Erza).

## Lebar uji
Smoke Playwright 360/390/768/1440 px (`docs/screenshots-v2/`, laporan `smoke-report.json`): 120 halaman tanpa error konsol, tanpa scroll horizontal.
