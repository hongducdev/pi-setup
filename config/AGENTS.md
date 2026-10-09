# Global instructions (Nguyễn Hồng Đức / GitHub: hongducdev)

## About me & environment
- I am Vietnamese. Windows 11, shell is Windows PowerShell 5.1 (use the `powershell` tool; avoid bash-only syntax there).
- Projects live in `D:\MyProjects\` (some repos sit directly on `D:\`, e.g. `D:\CrosSen`). Visual Studio and other programs live in `E:\Programs`.
- Linux toolchains (PlatformIO) run inside WSL (Ubuntu), not PowerShell. Windows drives map to `/mnt/d/...`.
- Native Windows desktop apps: C++23 + WinUI 3, VS template "WinUI Blank App (Packaged)", x64. Never use UWP, WPF or WinForms.
- My GitHub is `hongducdev`; repos are pushed there.

## Communication
- Always reply to me in Vietnamese. Code, identifiers, commit messages and docs stay in English unless the project is Vietnamese-facing.
- My messages are short, informal and often have typos (e.g. "sửa gips tôi" = "sửa giúp tôi"). Infer the intent; do not ask me to rephrase.
- "giúp tôi" is a request to do it, not to explain it. Act instead of describing what you would do.
- When there is a real choice, give numbered or lettered options and mark the one you recommend. I usually reply with just "1", "2", "a", "b", or "chọn phương án tối ưu nhất" / "theo khuyến nghị" — then take your recommended option without asking again.
- When I paste image paths (`...\AppData\Local\Temp\orca-paste-*.png`), open and look at them. They are screenshots of the bug or of the target UI.
- If I ask "tại sao..." / "có tác dụng gì", answer the question first; do not start changing code.

## Workflow
- I drive work through skills (`ck-fix`, `ck-cook`, `ck-code-review`, `ck-ask`, `ck-plan`, `ck-git`, `ui-ux`...). Follow the invoked skill's workflow and gates.
- For non-trivial features: write a plan (under the repo's `plans/` folder), wait for my "approve"/"duyệt"/"ok", then implement. "approve --auto" / "--auto" means run the remaining phases without stopping.
- "continue" / "tiếp tục" / "làm tiếp" / "hoàn thành nốt" = resume exactly where you stopped; do not restart or re-plan.
- "làm lần lượt" = do the listed items one by one, in order, finishing each before the next. "làm hết một lượt" = do all of them now.
- "xử lý dứt điểm" / "sửa để hết lỗi hoàn toàn" = keep going until the root cause is fixed and verified, not a partial patch.
- Before proposing a new feature, check the code for what already exists. Do not re-propose features I already have.
- When I give a reference (GitHub repo, website, APK, screenshot), study it and match it as closely as possible ("làm giống nhất có thể"), adapted to my stack.
- Stay inside the scope I asked for. Example: "review code" means review the code only — do not also scan the SD card or touch other things.

## Verification
- Never report "done" or "success" without proof. I often come back with "vẫn không hiển thị gì", "vẫn style cũ", "vẫn lỗi pio", "báo thành công nhưng chưa thực thi". Check the real result: build, run, look at the actual UI/output.
- Verify in the real target: the actual Tauri desktop app (not just the browser dev page), the simulator or device for firmware, `flutter analyze`/`flutter test` for Flutter.
- After a UI fix, check that nearby elements did not regress (alignment, layout of other rows/screens).
- If a previous command or build may have been cut off, check its result before moving on.
- For long builds/commands, stream output (e.g. `cmd 2>&1 | tee /tmp/build.log`) instead of redirecting silently to a file, so progress stays visible.
- For long builds (`pio run`, cargo/flutter/tauri builds), set the powershell/bash tool `timeout` generously (e.g. 3600s) so Pi's own timeout does not kill the build early; the live-log watchdog stops commands that are really stuck.
- Text and fonts must render Vietnamese diacritics correctly. When choosing or changing a font, check Vietnamese glyph coverage first.

## Git habits
- Do not commit or push unless I ask. I ask explicitly, almost always as "commit và push giúp tôi" (then do both), sometimes "commit giúp tôi" (commit only) or "push trước".
- Use Conventional Commit messages (`feat(scope): ...`, `fix: ...`, `docs: ...`). Commit only the relevant files.
- Use `main` as the default branch name (I moved nice-ebook from `master` to `main`). CrosSen firmware day-to-day work is on `develop`; push to the main branch only when I say so ("push vào nhánh chính").
- No GitHub Actions / CI-CD. I build locally. When I ask for a tag/release or version bump, do it locally (bump version, update README if asked, tag) without adding workflows.

## Engineering preferences
- Prefer clean, minimal UI: less text, no duplicated controls or features already available elsewhere (e.g. bottom navigation).
- "tối ưu" usually means performance and smoothness on weak hardware (low-end PCs without a GPU, the smaller Xteink X3 device, lag while staying connected) and removing dead code/unneeded files.
- When I ask for a core feature, build our own implementation instead of depending on a tool installed on my machine (e.g. no calling Calibre).
- Install tools/skills/plugins project-locally when I say so; do not install globally unless asked.

## Per-project notes
- `D:\CrosSen` — CrosSen: Vietnamese-first fork of CrossPoint Reader e-reader firmware for Xteink X3/X4 (ESP32-C3, C++20, PlatformIO, Arduino-ESP32). Very tight memory: ~380 KB RAM, no PSRAM, 48 KB framebuffer, no exceptions/RTTI, flash ~90%+ full — avoid heap churn and large additions. Reference fork for UI: github.com/tvhdc/crossvi.
  - Build/test in WSL: `wsl -d Ubuntu`, then `export PATH="$HOME/.platformio/penv/bin:$PATH"; cd /mnt/d/CrosSen; pio run` / `python3 scripts/run_simulator.py x3` / `python3 scripts/test_simulator.py`.
  - "truyền vào thẻ sd" = build latest firmware locally, produce `update.bin`, copy to the SD card (usually drive `F:\`). I use the X3. Check the card is mounted first. Branding is "CrosSen" (not CrossPoint/CrossVi); default UI language is Vietnamese.
- `D:\MyProjects\nice-ebook` — Vietnamese ebook studio desktop app: Tauri v2 + Rust backend, React 19 + TypeScript + Zustand + Tailwind v4 + shadcn-style UI, pnpm. Features: AI translation (reference: github.com/neavo/LinguaGacha), EPUB/Kindle conversion, AI agent tools. Lint must pass.
- `D:\MyProjects\nice-booxbook` — AI book editor desktop app: Tauri + Rust (`cargo test --manifest-path src-tauri/Cargo.toml`) + React/TS (`npm run build`). Own project format, auto-save, Catppuccin palette. Plans in `plans/`.
- `D:\MyProjects\CrosSen-mobile` — Flutter (Android) companion app for CrosSen: send books/fonts, settings, page turner, via the firmware's `/api/v1` companion API (WiFi) and Bluetooth. Keep app and firmware in sync — when changing one, check the other repo. Material 3 style, minimal screens.
- `D:\CrosSen-web` — static bilingual (Vietnamese default + English) marketing site for CrosSen, modeled on crosspointreader.com (Astro + Tailwind per its plan).

## Safety
- Ask before destructive actions: deleting files/folders, deleting remote branches/repos/files on GitHub, wiping the SD card, force-push, history rewrites. Explain what the thing does before deleting it, not after.
- When I ask to delete or clean, delete only what I named (e.g. "chỉ xóa các file ảnh hưởng tới việc push lên GitHub", "chỉ giữ lại sách và font"). List what will be removed first.
- Read-only tasks (reviews, audits, research) must not modify the working tree, run builds that write artifacts, or run writing git commands.
- Never write secrets, tokens or keys into code, commits, or chat.
