# Supplier-ID Android (pelanggan)

Pembungkus Capacitor atas web build (aset dibundel di APK, API absolut ke `https://supplier-api.antarkitaindonesia.com`).
Backend & aturan bisnis tetap satu di server; aplikasi ini = klien yang sama dengan web (keranjang, checkout, OTP, konfirmasi 24 jam, scan).

## Build (membutuhkan Android SDK — tidak tersedia di sandbox Claude; dibangun otomatis oleh GitHub Actions `android.yml`)
```
cd web && npm ci && VITE_BASE=/ VITE_API_URL=https://supplier-api.antarkitaindonesia.com npx vite build --outDir ../android-app/www --emptyOutDir
cd ../android-app && npm ci && npx cap sync android
cd android && ./gradlew assembleDebug        # APK uji: app/build/outputs/apk/debug/app-debug.apk
cd android && ./gradlew bundleRelease        # AAB rilis (unsigned) — tanda tangani dengan keystore milik pemilik (jangan simpan keystore di repo)
```
Signing rilis: buat keystore di mesin pemilik (`keytool -genkeypair …`), isi `android/keystore.properties` (di-gitignore), lalu aktifkan `signingConfigs.release` di `android/app/build.gradle`.

## Push notification
Token perangkat dikirim ke `POST /api/me/push-token` (sudah ada). Pengiriman push memerlukan proyek Firebase (google-services.json + FCM key di server) — belum dikonfigurasi (blocker: akun Firebase pemilik).

## Deep link
`https://antarkitaindonesia.com/supplier-id/*` membuka aplikasi (App Links). Verifikasi otomatis butuh `/.well-known/assetlinks.json` di domain berisi SHA-256 sertifikat signing.
