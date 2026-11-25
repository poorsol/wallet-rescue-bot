# Wallet Rescue Bot (ETH EIP-7702 + MEV Bundle | SOL Jito | TRX Stake 2.0)

Alat CLI lokal untuk menyelamatkan aset atau mengirim transaksi dari wallet yang terkena **drainer / sweeper** (selama kamu masih memegang private key-nya).

> **PERINGATAN KEAMANAN**
> - Jalankan **100% lokal** di komputer kamu sendiri.
> - **JANGAN PERNAH** membagikan file `.env` atau menaruh private key di tempat publik.
> - Selalu jalankan mode **DRY-RUN / Simulasi** terlebih dahulu sebelum mengirim transaksi live.
> - Wallet yang private key-nya pernah bocor adalah **permanen tidak aman** — jangan pernah menyimpan dana di sana lagi setelah proses rescue selesai.

---

## Fitur Utama

### 1. Ethereum Mainnet (`ETH`)
- **Deteksi otomatis EIP-7702 drainer** (`0xef0100...`).
- **3-Transaksi Atomic Private Bundle** dikirim langsung ke MEV Builders (**Titan Builder, Flashbots, Beaverbuild, Rsync**) — tidak lewat *public mempool* sehingga anti-frontrun:
  1. **Tx #1 (Type 4 / EIP-7702)**: Sponsor membayar gas untuk mencabut delegasi drainer pada wallet korban ke `0x000...000`.
  2. **Tx #2 (Type 2)**: Sponsor menyuntikkan ETH ke wallet korban persis sampai 1 wei (`value + gasLimit × maxFeePerGas`).
  3. **Tx #3 (Type 2)**: Wallet korban langsung mengirim ETH / ERC-20 / NFT / atau menjalankan *custom calldata* (mis. `claim()` + otomatis transfer ERC-20 hasil claim di blok yang sama!).
- Dilengkapi simulasi `eth_callBundle` sebelum kirim live.

### 2. Solana (`SOL`)
- **Zero SOL ke wallet korban**: Sponsor bertindak sebagai `feePayer` 100%, sehingga sweeper SOL tidak pernah mendapat apa pun.
- **Atomic Multi-Instruction**: Dalam 1 transaksi, sponsor membuatkan ATA tujuan, wallet korban mentransfer semua SPL / Token-2022, dan opsional langsung menutup akun token kosong untuk menarik kembali rent (~0.002039 SOL) langsung ke **wallet aman**.
- Dikirim lewat **Jito Private Bundle** ke 4 region Block Engine sekaligus (anti-frontrun), dengan simulasi RPC terlebih dahulu.

### 3. Tron (`TRX`)
- **Audit Multi-Sig Takeover otomatis**: Mengecek `owner_permission` & `active_permission` sebelum melakukan apa pun. Jika attacker sudah mengubah permission menjadi multi-sig, bot langsung memberi tahu dan membatalkan agar kamu tidak membuang resource.
- **0 TRX ke wallet korban**: Jika permission masih utuh (sweeper biasa), sponsor bisa **Delegate Energy & Bandwidth (Stake 2.0, unlocked)** ke wallet korban, langsung transfer TRC-20 (mis. USDT), lalu otomatis **menarik kembali (`undelegate`)** Energy/Bandwidth ke sponsor!

---

## Cara Menggunakan (Pemula)

### Langkah 1: Siapkan File `.env`
1. Buka folder `wallet-rescue-bot`.
2. Copy file `.env.example` dan ubah namanya menjadi `.env`.
3. Isi bagian chain yang ingin kamu pakai (ETH / SOL / TRX):
   - **`*_SPONSOR_PRIVATE_KEY`**: Private key wallet **AMAN** baru yang berisi sedikit ETH / SOL (atau Staked TRX) untuk bayar biaya gas.
   - **`*_VICTIM_PRIVATE_KEY`**: Private key wallet **KORBAN** yang kena drain.
   - **`*_SAFE_RECIPIENT`**: Alamat wallet **AMAN** tujuan pengiriman aset.

### Langkah 2: Jalankan Menu Interaktif
Buka terminal di folder proyek lalu jalankan:
```bash
npm start
```
Tinggal pilih nomor menu (1–6) dan ikuti pertanyaan di layar. Bot secara default akan menawarkan **DRY-RUN (Simulasi)** dulu sebelum kirim live.

---

## Perintah CLI Cepat (Opsional)

### Cek Status Wallet (Read-Only, Tidak Butuh Private Key!)
```bash
# Cek status & deteksi EIP-7702 pada wallet Ethereum
npm run eth:check 0x8e9c9d296d01b65bdbde95fb293c0a7db02d3144

# Cek status & daftar token SPL pada wallet Solana
npm run sol:check <ALAMAT_SOLANA>

# Cek status & deteksi Multi-Sig Takeover pada wallet Tron
npm run trx:check <ALAMAT_TRON>
```

### Contoh Eksekusi Rescue
```bash
# ETH: Kirim 0.001 ETH dari wallet korban ke tujuan (simulasi dulu)
npm run eth:rescue -- --mode eth --amount 0.001 --dry-run

# ETH: Rescue semua saldo ERC-20 (mis. USDT)
npm run eth:rescue -- --mode erc20 --token 0xdAC17F958D2ee523a2206206994597C13D831ec7 --amount max --dry-run

# SOL: Rescue semua SPL token + tutup akun token kosong (reclaim rent ke wallet aman)
npm run sol:rescue -- --mode spl --mint all --close --dry-run

# TRX: Rescue USDT TRC-20 dengan pinjam Energy sementara (3000 TRX staked, otomatis ditarik balik)
npm run trx:rescue -- --amount max --delegate-energy 3000 --dry-run

# TRX: Kirim TRX dari wallet korban ke alamat wajib via Offline Pre-Sign & Rapid-Fire Relay
npm run trx:relay -- --amount 4 --recipient TEK6BJ1BevocAx8TQd2p1cc7gamWqk9KWA --dry-run

# TRX: Standby Auto-Forward Watcher (otomatis teruskan TRX masuk ke wallet aman pribadi)
npm run trx:watch -- --recipient <WALLET_AMAN_PRIBADI> --min 0.5
```
*(Hapus `--dry-run` jika hasil simulasi sudah sukses dan kamu siap mengirim transaksi live.)*

---

## Tips Agar Sukses Saat Eksekusi Live
- **Ethereum**: Jika bundle belum masuk setelah 15 blok, naikkan `ETH_PRIORITY_FEE_GWEI` di `.env` (mis. `3` atau `5`) karena builder memprioritaskan tip yang lebih kompetitif.
- **Solana**: Jika jaringan sedang sibuk, naikkan `SOL_JITO_TIP_LAMPORTS` (mis. `500000` = 0.0005 SOL) atau gunakan RPC berbayar (Helius / QuickNode) di `SOL_RPC_URL`.
- **Tron**: Pastikan wallet penerima sudah punya minimal sedikit USDT (atau siapkan ~131,000 Energy jika penerima 0 USDT). Jangan pernah mengirim TRX cair ke wallet korban!
