# Pi Setup — Cấu hình Pi Coding Agent portable

Snapshot cấu hình [Pi Coding Agent](https://pi.dev) đã tuỳ biến (Windows 11 + PowerShell 5.1) kèm script backup/restore, lấy ý tưởng từ [mrgoonie/zuey-pi-setup](https://github.com/mrgoonie/zuey-pi-setup).

Repo chỉ chứa cấu hình, extension và font dùng chung được. **Không** chứa secret, API key, token, session, cache hay dữ liệu runtime theo máy (xem [Bảo mật](#-bảo-mật--riêng-tư)).

> Đã kiểm thử với Pi **1.1.0** (Node 24).

---

## 📦 Packages (`config/settings.json`)

| Package | Vai trò |
|---|---|
| `npm:pi-antigravity` | Provider Antigravity / Cloud Code Assist (model mặc định `antigravity/gemini-3.8-flash`, thinking `high`). |
| `npm:pi-footer` | Statusline nhiều hàng tuỳ biến (layout ở `config/extensions/pi-footer.json`). |
| `npm:timestamp-pi` | Timestamp dưới mỗi message + đếm ngược prompt cache. |
| `npm:@tmustier/pi-session-recap` | Recap "while you were away" khi quay lại session. |
| `npm:@tintinweb/pi-subagents` | Subagent kiểu Claude Code: tool `Agent`, chạy song song/nền, FleetView, `/agents`. |
| `extensions\subagents-pi` | Bảng metrics fleet subagent (context, TPS, model, thinking) — companion của `@tintinweb/pi-subagents`. |
| `npm:pi-advisor-flow` | Executor / Advisor flow (ý kiến thứ hai), cấu hình ở `config/advisor.json`. |
| `npm:pi-mcp-adapter` | MCP adapter (MCP builtin của Pi bị tắt bằng `"extensions": ["-builtin:mcp"]`). |
| `npm:pi-lens` | Chẩn đoán code real-time (LSP, linter, formatter, type-check). Cấu hình ở `pi-lens/`. |
| `npm:pi-model-fallback` | Tự chuyển sang model dự phòng khi provider lỗi (429, 5xx). |
| `extensions\pi-goal-orch` | Lệnh `/goal`: chạy chuỗi skill theo stage; mỗi goal một worktree/branch (qua Orca nếu đang chạy), tự review rồi merge. |
| `npm:pi-skillful` | Cải thiện gọi/hiển thị skill; phím tắt toggle slot 1–6 = `ck-cook`, `ck-fix`, `ck-debug`, `ck-code-review`, `ck-git`, `ck-ask`. |

Extension file đơn trong `config/extensions/*.ts` và thư mục có `index.ts` được Pi tự load (không cần khai báo trong `packages`).

> `9router-pi` (từ [luongnv89/pi-extensions](https://github.com/luongnv89/pi-extensions)) vẫn nằm trong repo nhưng **không còn bật** (đã bỏ khỏi `settings.json`). Muốn dùng lại: thêm `"extensions\\9router-pi"` vào `packages`.

---

## 🧩 Extension tự viết / đã chỉnh

### `live-log.ts` — log trực tiếp + watchdog cho lệnh shell chạy lâu
- Hiện đuôi log ngay trong dòng tool đang chạy (build `pio run`, `wsl ... bash build.sh`, `Start-Job` + poll...). Tự dò file log từ redirect (`>`, `>>`, `| tee`, `Out-File`, `-RedirectStandardOutput`, script `.sh/.ps1`...) và map đường dẫn WSL (`/mnt/d/x` → `D:\x`).
- Watchdog: không có output mới quá giới hạn *stall* hoặc chạy quá *max* → huỷ lượt (như Esc), cảnh báo trước, phân tích lỗi cục bộ và nhờ agent tóm tắt. Giới hạn tự chọn theo loại lệnh (test / install / build / default).
- Lệnh: `/livelog` (trạng thái) · `/livelog <path>` · `off` · `lines <n>` · `widget on|off` · `watchdog on|off` · `stall|max <phút>|auto` · `limits` · `forget` · `keep` · `stop` · `last` · `lang en|vi|auto`.
- Cấu hình mặc định: `config/live-log.json`. Lịch sử (`live-log-history.json`, `live-log-last-stop.md`) là dữ liệu theo máy, không đưa vào repo.

### `env-context.ts` — giúp Pi viết lệnh đúng cho máy & project
- Thêm vào system prompt một khối ngắn, ổn định (thân thiện prompt cache): shell thật đang dùng (Windows PowerShell 5.1), Git Bash vs WSL, tool nằm ở Windows hay WSL, recipe theo project (PlatformIO, npm/pnpm/bun theo lockfile, Cargo, CMake, Flutter, Tauri, Go, Python, .NET).
- Chặn lệnh sai rõ ràng kèm lý do sửa (bash-ism trong PowerShell, `&&` trên PS 5.1, `pio run` trên Windows ở project build bằng WSL, sai package manager...). Không tự sửa lệnh; thêm `# envctx:allow` để bỏ qua.
- Tự học: lệnh lỗi rồi lệnh tương tự thành công → lưu cách sửa (đã redact, chỉ trên máy).
- Lệnh: `/envctx` · `/envctx refresh` · `learned` · `forget <n>|all` · `guard on|off`.
- Cache/learned (`env-context-cache.json`, `env-context-learned.json`) là dữ liệu theo máy, không đưa vào repo.

### `pi-goal-orch/` — `/goal` chạy skill theo stage
- `/goal <mô tả>`: model lập kế hoạch bằng tool `submit_goal_plan` từ các skill đã cài, runner soft-prompt từng skill.
- **Chế độ do người dùng quyết định**: mặc định **AFK** (tự chuyển stage). `/goal --hitl <mô tả>` để dừng sau mỗi stage. `mode` model gửi lên bị bỏ qua.
- **Checkpoint** (`⏸`): stage cần duyệt (ví dụ duyệt plan trước khi sửa code, hoặc instruction có “Chờ tôi duyệt”) — AFK chỉ dừng sau các stage này.
- Chỉ dừng khi tin nhắn cuối của stage thật sự hỏi người dùng; trả lời xong goal tự chạy tiếp.
- **Git isolation**: trong git repo, mỗi goal chạy trên branch `goal/<slug>-<ngày>` trong **worktree riêng** (mặc định; tạo qua `orca worktree create` nếu Orca đang chạy để hiện trong Orca UI, không thì `git worktree add`). Không đụng file chưa commit của bạn ở main tree. `/goal --branch …` (cần tree sạch) hoặc `/goal --no-git …`.
- **Kết thúc tự động**: stage `ck-code-review` → FAIL thì `ck-fix` + review lại (tối đa 2 vòng) → PASS thì `merge --no-ff` vào base (không push), xoá worktree + `branch -d`. Test stage FAIL thì không merge. Chạy **nhiều goal song song**: registry + merge lock, base đi tiếp thì merge base vào goal rồi review/test lại, cảnh báo sớm khi 2 goal sửa cùng file, conflict thì abort và dừng.
- Lệnh: `/goal status` · `/goal next` · `/goal auto` (sang AFK, đang dừng thì chạy tiếp) · `/goal hitl` · `/goal merge` · `/goal abandon` (giữ branch/worktree) · `/goal goals` · `/goal skip` · `/goal retry` · `/goal cancel` · `/goal skills` · `/goal help`. Cấu hình `~/.pi/agent/goal-orch.json` (`git`, `merge: auto|ask`, `keepBranch`, `orca`, `orcaSetup: inherit|run|skip`, `orcaAutoAddRepo`, …). Chi tiết: [`config/extensions/pi-goal-orch/README.md`](config/extensions/pi-goal-orch/README.md).

### `model-router.ts` — model theo loại việc
- Việc **lập kế hoạch / review** (skill có tên chứa `plan`, `review`, `scout`, `brainstorm`, `ask`, `research`, `audit`, `explore`, `spec`, `design`… như `ck-plan`, `ck-code-review`, `ck-scout`) → `opencode-go/deepseek-v4.1-flash`.
- Việc **code** (`cook`, `fix`, `implement`, `code`, `build`, `refactor`, `debug`, `test`… như `ck-cook`, `ck-fix`, `ck-test`) → `antigravity/gemini-3.8-flash`.
- Bắt được: `/skill:<tên>`, `/<tên-skill>`, slot Alt+N (chèn `/skill:`), stage của `/goal` (“Use the skill …”), và khi model tự đọc `…/<skill>/SKILL.md`. Subagent `@tintinweb/pi-subagents`: `Agent` không chỉ định `model` thì `Plan`/`Explore` → plan, `general-purpose` → code (agent tuỳ chỉnh giữ model trong frontmatter).
- Hết lượt (agent settled) thì **trả lại model trước đó**; nếu bạn tự đổi model giữa chừng (hoặc `pi-model-fallback` đổi khi lỗi) thì không ghi đè. Model đích không có / chưa đăng nhập / `setModel` thất bại → giữ model hiện tại và báo.
- `/router` (trạng thái) · `/router on` · `/router off` · `/router reload`. Cấu hình `~/.pi/agent/model-router.json`: `{ "enabled", "models": { "plan", "code" }, "rules", "skills": { "<tên>": "plan|code|none" }, "subagents", "restore" }`. OpenCode Go là provider có sẵn của Pi (đăng nhập bằng `/login`, key nằm trong `auth.json` — không lưu trong repo).

### `pi-prompt-suggest/` — gợi ý prompt tiếp theo dạng ghost text
- Sau mỗi lượt, gợi ý câu lệnh tiếp theo hiện mờ trong editor; `→` để nhận (hoặc Space khi editor trống). Mặc định **tắt**.
- Bật: `pi --prompt-suggest` hoặc `/suggester on`. Lệnh: `/suggester status|on|off|auto on|off|demo|clear|prompt|config <key> <value>`.
- Ý tưởng tham khảo [guwidoe/pi-prompt-suggester](https://github.com/guwidoe/pi-prompt-suggester), code viết riêng.

### Footer (`pi-footer`)
- **`pi-footer.json`** — 4 hàng: (1) cwd · model · tài khoản Antigravity · thinking · active tools; (2) context bar · cache hit · cache TTL · TPS · tổng thời gian; (3) git branch/diff · cost (kèm subscription) · MCP · advisor · pi-lens LSP · usage; (4) goal · background-tasks · worktree · model-fallback · advisor-scout · session-recap · stash. Đã bỏ `subagent-slash` / `subagent-slash-text` (chỉ có ở `pi-subagents` của nicobailon, không dùng). Các status này được ẩn khỏi hàng status mặc định để không hiện trùng.
- **`footer-compact.ts`** — rút gọn status ồn: `Advisor: 4 calls … $0.0184` → `Advisor 4x $0.0184`, `MCP: 1 server enabled` → `MCP 1`, ẩn `LSP Inactive`, `LSP Active: ts, py` → `LSP ts, py`.
- **`antigravity-account-footer.ts`** — hiện tài khoản pi-antigravity đang dùng (widget `ag_account`), tự cập nhật khi failover. Chỉ đọc `activeAccountId`/email từ `antigravity-accounts.json` trên máy, không bao giờ đọc token; file đó **không** có trong repo.
- **`pi-footer-cache-tps.ts`** — đếm ngược thời gian sống prompt cache (Anthropic 5m/1h, OpenAI 24h/30m; provider không rõ TTL thì hiện tuổi cache `~`) và tốc độ token (TPS) vào widget `cache_ttl` / `tps`.

### `subagents-pi/` (bản đã vá)
- Gốc từ [luongnv89/pi-extensions](https://github.com/luongnv89/pi-extensions). Vá `src/render.ts` (2026-10-08): **ẩn panel khi không có subagent nào** thay vì hiện “No active subagents”.
- Lệnh: `/subagents-pi` (bật/tắt panel) · `/subagents-pi-refresh`.

---

## 🔍 pi-lens (`pi-lens/`)

- **`pi-lens/config.json`** → `%USERPROFILE%\.pi-lens\config.json` (cấu hình global):
  - Bỏ qua thư mục build/sinh mã: `.pio`, `node_modules`, `dist`, `build`, `target`, `.dart_tool`, `.astro`, `.cache`, `*.generated.*`, `*.min.js`.
  - Tắt các LSP server không khởi động được trên Windows (spawn lỗi mỗi lần sửa file, tốn 2–4.5s và làm file sạch bị báo "skipped"): `typos`, `marksman`, `python`, `python-jedi`, `yaml`, `json`, `css`, `html`, `bash`, `cmake`, `kotlin`, `zizmor`. Linter dạng CLI (pyright, ruff, ...) vẫn chạy.
- **`pi-lens/examples/CrosSen.pi-lens.json`** — ví dụ `.pi-lens.json` cho project PlatformIO/ESP32: dùng `clangd` với `--query-driver` trỏ tới toolchain ESP32 (thay `YOUR_USER`), tắt checker `g++` của host (báo sai "Arduino.h not found"), bỏ qua test gtest chỉ build bằng CMake. Đặt vào gốc project và thêm vào `.gitignore` / `.git/info/exclude`.
- Rust: cần `rustup component add rust-analyzer` để LSP Rust hoạt động.

---

## 📝 Hướng dẫn chung cho agent — `config/AGENTS.md`

Hướng dẫn global của Pi (`~/.pi/agent/AGENTS.md`): luôn trả lời tiếng Việt, môi trường Windows/PowerShell 5.1 + WSL cho PlatformIO, quy trình skill `ck-*` (plan → duyệt → làm), cách verify, thói quen git, ghi chú theo project và quy tắc an toàn.

---

## 📁 Cấu trúc repo

```text
.
├── config/                          # Mirror của ~/.pi/agent (restore copy toàn bộ vào đó)
│   ├── settings.json                # Packages, model mặc định, skillful toggle slots
│   ├── advisor.json                 # Cấu hình pi-advisor-flow
│   ├── AGENTS.md                    # Hướng dẫn global cho agent
│   ├── live-log.json                # Cấu hình mặc định live-log
│   ├── .pi-setup-exclude            # Glob loại trừ khi backup (secret, runtime, node_modules, *.bak)
│   └── extensions/
│       ├── live-log.ts
│       ├── env-context.ts
│       ├── footer-compact.ts
│       ├── antigravity-account-footer.ts
│       ├── pi-footer-cache-tps.ts
│       ├── pi-footer.json           # Layout pi-footer
│       ├── pi-goal-orch/            # /goal (+ worktree/Orca/review/merge)
│       ├── model-router.ts          # /router — plan/review vs code model
│       ├── pi-prompt-suggest/       # Ghost-text prompt suggestions
│       ├── subagents-pi/            # Fleet metrics (đã vá render.ts)
│       └── 9router-pi/              # (không bật)
├── pi-lens/
│   ├── config.json                  # → %USERPROFILE%\.pi-lens\config.json
│   └── examples/CrosSen.pi-lens.json
├── fonts/GeistMono/                 # GeistMono Nerd Font v3.5.1
├── scripts/
│   ├── pi-setup-restore.ps1         # Khôi phục setup vào ~/.pi/agent (+ ~/.pi-lens)
│   ├── pi-setup-backup.ps1          # Sao lưu từ máy vào repo (tôn trọng .pi-setup-exclude)
│   ├── patch-extension-deps.ps1     # Chuyển host package (typebox, pi-*) sang peerDependencies "*"
│   ├── fix-skill-names.mjs          # Chuẩn hoá tên skill (a-z, 0-9, -) sau khi cài lại skill kit
│   ├── install-geist-font.ps1       # Cài font vào Windows
│   └── pi-setup-verify-advisor.mjs  # Kiểm tra advisor.json theo schema
└── README.md
```

---

## 🚀 Cài đặt trên máy mới (Windows)

1. Cài Node.js ≥ 22 và Pi: `npm i -g @earendil-works/pi-coding-agent`.
2. Clone repo:
   ```powershell
   git clone git@github.com:hongducdev/pi-setup.git
   cd pi-setup
   ```
3. Khôi phục cấu hình (tự backup `settings.json` cũ thành `settings.json.bak.<thời gian>`; `-Force` để ghi đè `~/.pi-lens/config.json` đã có):
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\pi-setup-restore.ps1 -InstallFont
   ```
4. Mở Pi để cài packages trong `settings.json`, rồi kiểm tra:
   ```powershell
   pi list
   pi
   ```
5. Đăng nhập provider trong Pi (`/login`) — token lưu ở `auth.json` / `antigravity-accounts.json` trên máy, không có trong repo.
6. Tuỳ chọn: `node .\scripts\fix-skill-names.mjs` sau khi cài skill kit; `rustup component add rust-analyzer` cho pi-lens Rust; copy `pi-lens/examples/*.pi-lens.json` vào project cần.

## 🔄 Cập nhật

- **Máy → repo**: `powershell -ExecutionPolicy Bypass -File .\scripts\pi-setup-backup.ps1`, xem `git diff`, quét secret, rồi commit & push.
- **Repo → máy**: `git pull` rồi chạy lại `pi-setup-restore.ps1`.
- Trong Pi: `/reload` để nạp lại extension/cấu hình sau khi thay đổi.

---

## 🔒 Bảo mật & riêng tư

Không bao giờ đưa vào git (đã có trong `.gitignore` và `config/.pi-setup-exclude`):
- Token & tài khoản: `auth.json`, `antigravity-accounts.json`, `opencode-keys.json`, `mcp-oauth/`, `trust.json`.
- Lịch sử & bộ nhớ: `sessions/`, `memory/`, `opencode-usage.jsonl`, `advisor-outcomes*`.
- Cache / runtime theo máy: `models-store.json`, `mcp-cache.json`, `npm/`, `git/`, `bin/`, `live-log-history.json`, `live-log-last-stop.md`, `env-context-cache.json`, `env-context-learned.json`, `prompt-suggest/`, `backups/`, `*.bak*`, `node_modules/`.
- Extension do công cụ khác quản lý: `orca-*.ts` (Orca), `herdr-agent-state.ts` (herdr) — tự sinh lại khi cài các công cụ đó.

---

## 📜 Credits

- Cấu trúc portable setup: [mrgoonie/zuey-pi-setup](https://github.com/mrgoonie/zuey-pi-setup).
- `9router-pi`, `subagents-pi`: [luongnv89/pi-extensions](https://github.com/luongnv89/pi-extensions).
- Ý tưởng `pi-prompt-suggest`: [guwidoe/pi-prompt-suggester](https://github.com/guwidoe/pi-prompt-suggester).
- Font: [ryanoasis/nerd-fonts](https://github.com/ryanoasis/nerd-fonts).
