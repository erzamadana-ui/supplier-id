-- Versi token per user: naik saat ganti kata sandi → token lama (JWT) tidak berlaku. Juga dasar pencabutan sesi user yang dihapus.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0;
