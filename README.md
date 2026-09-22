# Pi Setup — Portable Pi Coding Agent Configuration

A portable snapshot of a customized [Pi Coding Agent](https://pi.dev) setup + backup/restore tooling, inspired by [mrgoonie/zuey-pi-setup](https://github.com/mrgoonie/zuey-pi-setup).

This repository contains shareable configurations, extensions, and fonts. It **strictly excludes** all secrets, API keys, cache, machine-specific states, and session transcripts.

---

## 🌟 Features Included

| Component | Description |
|---|---|
| **`pi-footer`** | Statusline 3 hàng tùy biến tinh gọn: `context-bar` thích ứng theo model window, `cache-hit-rate`, cache TTL countdown, tốc độ phản hồi `tps`, git diff/branch, chi phí token, và gom gọn 14 external statuses (bao gồm `advisor-scout` & `advisor-usage`). |
| **`pi-advisor-flow`** | Executor / Advisor flow: ý kiến thứ hai từ model mạnh hơn, tích hợp trực tiếp 2 status widgets (`advisor-scout`, `advisor-usage`) vào pi-footer và có công cụ kiểm tra schema tự động. |
| **`pi-footer-cache-tps`** | Extension đo lường thời gian sống prompt cache (Anthropic 5m/1h, OpenAI 24h/30m) & tốc độ token streaming (TPS). |
| **`9router-pi`** | Dynamic 9router model discovery cho Pi Coding Agent từ [luongnv89/pi-extensions](https://github.com/luongnv89/pi-extensions). |
| **`subagents-pi`** | Bảng metrics theo dõi fleet subagent (Context usage, output TPS, model, thinking level). |
| **`@tmustier/pi-session-recap`** | Recap "while you were away" khi quay lại session sau khi multi-agenting. |
| **`GeistMono Nerd Font`** | Bộ font Nerd Font (`v3.5.1`) hiển thị đầy đủ icon và statusline glyphs cho terminal. |

---

## 📁 Repository Structure

```text
.
├── config/
│   ├── settings.json                # Danh sách packages & thiết lập Pi portable
│   ├── advisor.json                 # Cấu hình pi-advisor-flow (model, scout, footer)
│   ├── .pi-setup-exclude            # Quy tắc loại trừ các file/folder nhạy cảm
│   └── extensions/
│       ├── pi-footer.json           # Layout cấu hình 3 hàng của pi-footer (14 statuses)
│       ├── pi-footer-cache-tps.ts   # Script đo lường Cache TTL & TPS
│       ├── 9router-pi/              # Extension 9router
│       └── subagents-pi/            # Extension subagents fleet metrics
├── fonts/
│   └── GeistMono/                   # 54 variants của GeistMono Nerd Font
├── scripts/
│   ├── install-geist-font.ps1       # Script cài font tự động vào Windows
│   ├── pi-setup-restore.ps1         # Khôi phục setup vào ~/.pi/agent
│   ├── pi-setup-backup.ps1          # Sao lưu thay đổi từ ~/.pi/agent vào repo
│   └── pi-setup-verify-advisor.mjs  # Kiểm tra tính hợp lệ của advisor.json theo schema
└── README.md
```

---

## 🚀 Quick Start & Restore

### Khôi phục trên máy mới (Windows):

1. **Clone repository:**
   ```bash
   git clone git@github.com:hongducdev/pi-setup.git
   cd pi-setup
   ```

2. **Khôi phục cấu hình:**
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\pi-setup-restore.ps1 -InstallFont
   ```

3. **Cài đặt dependencies và khởi chạy:**
   ```powershell
   pi list
   pi
   ```

---

## 🔒 Security & Privacy

Repository này tuân thủ nguyên tắc bảo mật thông tin cá nhân:
- **Không chứa API Keys**: `auth.json` không bao giờ được đưa vào git.
- **Không chứa lịch sử chat**: Thư mục `sessions/` được đưa vào `.gitignore`.
- **Không chứa cache máy**: `models-store.json`, `npm/`, `git/`, `bin/` được loại trừ.

---

## 📜 Credits

- Dựa trên ý tưởng và cấu trúc portable setup của [mrgoonie/zuey-pi-setup](https://github.com/mrgoonie/zuey-pi-setup).
- Extensions `9router-pi` và `subagents-pi` từ [luongnv89/pi-extensions](https://github.com/luongnv89/pi-extensions).
- Font từ [ryanoasis/nerd-fonts](https://github.com/ryanoasis/nerd-fonts).
