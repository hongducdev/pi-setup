# pi-goal-orch

> **VI** — Lệnh `/goal` cho [Pi](https://pi.dev): khám phá skill đã cài và chạy từng giai đoạn (stage) để hoàn thành mục tiêu.
>
> **EN** — A `/goal` slash command that discovers installed skills and soft-prompts them as ordered stages toward a user goal.

## Cài đặt / Install

Thử nhanh (không cần build — Pi load TypeScript bằng jiti):

```bash
pi -e /workspace/pi-goal-orch
# hoặc từ thư mục package:
cd /workspace/pi-goal-orch && pi -e ./
```

Cài bền (user/project):

```bash
pi install /workspace/pi-goal-orch
# hoặc sau này khi publish:
# pi install pi-goal-orch
```

Peer deps (`@earendil-works/pi-coding-agent`, `typebox`, …) lấy từ bản Pi đã cài — không bắt buộc `npm install` trong package này.

## Cách dùng / Usage

| Lệnh | Mô tả |
|------|--------|
| `/goal <mô tả>` | Khám phá skill → nhờ model gọi `submit_goal_plan` → chạy stage ở chế độ **AFK** (mặc định) |
| `/goal --hitl <mô tả>` | Như trên nhưng chạy **HITL**: dừng sau mỗi stage (tương đương `/goal hitl <mô tả>`) |
| `/goal --worktree\|--branch\|--no-git <mô tả>` | Chọn cách cô lập git cho goal (mặc định `worktree`, đổi trong `goal-orch.json`) — kết hợp được với `--hitl` |
| `/goal` / `/goal status` | Xem trạng thái goal hiện tại + branch/worktree/base, kết quả review/test (`⏸` = stage checkpoint) |
| `/goal merge` | Review (nếu chưa có review PASS cho HEAD hiện tại) rồi merge `--no-ff` vào base, dọn worktree + branch |
| `/goal abandon` | Dừng goal, **giữ** branch/worktree và in đường dẫn (`/goal cancel` cũng giữ) |
| `/goal goals` | Liệt kê các goal đang chạy song song (registry) |
| `/goal skills` | Liệt kê skill phát hiện được |
| `/goal next` | Tiếp tục sau khi tạm dừng (HITL / checkpoint / model hỏi lại) |
| `/goal auto` | Chuyển goal hiện tại sang AFK; nếu đang dừng sau một stage thì chạy tiếp ngay |
| `/goal hitl` | Chuyển goal hiện tại sang HITL (dừng sau mỗi stage) |
| `/goal skip` | Bỏ qua stage hiện tại |
| `/goal retry` | Chạy lại stage hiện tại |
| `/goal cancel` | Dừng goal |
| `/goal help` | Xem tóm tắt lệnh |

Ví dụ:

```text
/goal Xây landing page cho sản phẩm X, từ brainstorm đến code
```

Model sẽ thấy danh sách skill (ưu tiên tên kiểu AgentKit: `ak-brainstorm`, `ak-plan`, `ak-cook`, … nếu có) và **phải gọi tool** `submit_goal_plan` với `stages` có thứ tự. Runner sau đó soft-prompt từng skill.

### Chế độ chạy: AFK / HITL / checkpoint

- **Người dùng quyết định chế độ, không phải model.** Mặc định là **AFK**: hết stage này tự chạy stage tiếp theo. Chỉ chạy **HITL** khi bạn yêu cầu (`/goal --hitl <mô tả>` hoặc `/goal hitl`).
- Tham số `mode` của `submit_goal_plan` vẫn còn trong schema để tương thích, nhưng **bị bỏ qua**: nếu model gửi `"HITL"` mà bạn không yêu cầu thì goal vẫn chạy AFK.
- **Checkpoint**: model có thể đánh dấu `checkpoint: true` cho stage *thật sự* cần bạn duyệt (ví dụ duyệt plan trước khi sửa code), tối đa 2 stage. Stage có instruction yêu cầu chờ duyệt (ví dụ “Chờ tôi duyệt plan”, “wait for my approval”) cũng được coi là checkpoint — kể cả goal lập trước bản này. Ở AFK, goal chỉ dừng **sau** stage checkpoint; các stage khác tự chạy tiếp. `/goal status` hiển thị dấu `⏸` cạnh stage checkpoint.
- Đổi chế độ giữa chừng: `/goal auto` (sang AFK — nếu goal đang dừng sau một stage thì chạy tiếp luôn) hoặc `/goal hitl` (sang HITL).

## Git: mỗi goal một branch/worktree, review rồi merge

Khi `cwd` nằm trong git repo, goal được cô lập ngay lúc `/goal …`:

| Chế độ | Làm gì |
|---|---|
| `worktree` (mặc định) | Tạo branch `goal/<slug>-<yyyymmdd-hhmm>` từ `HEAD` hiện tại, trong worktree riêng. Nếu **Orca** đang chạy: tạo qua `orca worktree create` (hiện trong Orca UI, repo chưa có trong Orca thì tự `orca repo add`); nếu không: `git worktree add <repoParent>/.worktrees/<repo>-goal-<slug>-<ngày>`. **Không đụng** thay đổi chưa commit ở main tree (chúng không có trong worktree — thông báo lúc start sẽ nhắc). |
| `--branch` | `git switch -c goal/…` ngay trong working tree hiện tại. **Từ chối** nếu tree còn file chưa commit (dùng worktree thay vào). |
| `--no-git` | Không quản lý git (như bản cũ). |

- **Pi không cho extension đổi cwd của session**, nên mọi prompt stage được chèn khối *Git isolation*: chỉ làm việc trong `<worktree>`, mọi lệnh shell bắt đầu bằng `cd "<worktree>" && …`, sửa file bằng đường dẫn tuyệt đối dưới worktree, commit sau mỗi stage có sửa code (conventional message, theo AGENTS.md), **không** push/switch/merge/rebase. env-context nhận diện project theo `cd` đầu lệnh nên hoạt động bình thường với đường dẫn worktree.
- **Kết thúc (tự động)**: nếu plan chưa kết thúc bằng stage review thì tự thêm stage `ck-code-review` (đổi bằng `reviewSkill`). Stage review xem `git diff <base>...HEAD` và báo kết quả bằng tool `goal_report` (`kind: review`, `verdict: PASS|FAIL`) — hoặc dòng `VERDICT: PASS|FAIL`.
  - **FAIL** → tự chèn stage `ck-fix` + review lại, tối đa `maxFixLoops` (mặc định 2) vòng, sau đó dừng chờ bạn (`/goal merge` để review lại).
  - **PASS** → nếu plan có stage test (`ck-test`…) mà lần test cuối **FAIL** thì không merge. `merge: ask` → dừng chờ `/goal merge`. Còn lại: merge.
- **Merge** (không bao giờ push / force / xoá việc chưa merge):
  1. Lấy **merge lock** của repo (`~/.pi/agent/goal-orch-locks/`) — goal khác đang merge thì đợi và tự thử lại.
  2. Base đã đi tiếp (goal khác vừa merge) → merge base mới vào goal branch trong worktree; **conflict → `merge --abort`, dừng chờ bạn**; sạch → chạy lại test (nếu plan có) + review rồi mới merge.
  3. `git -C <main> merge --no-ff goal/…` — chỉ khi main tree đang checkout đúng base; nếu git từ chối vì sẽ ghi đè file chưa commit của bạn hoặc conflict → abort, dừng, không mất gì.
  4. Thành công → xoá worktree (`orca worktree rm` / `git worktree remove`, không `--force`; worktree còn file chưa commit thì giữ) và `git branch -d` (giữ nếu `keepBranch: true`).
- **Chạy song song**: registry `~/.pi/agent/goal-orch-registry.json` giữ branch/worktree/file đã sửa của mọi goal đang chạy (mỗi session Pi một goal) → không trùng branch/worktree; khi 2 goal sửa cùng file thì cảnh báo sớm (lúc bắt đầu mỗi stage), merge được xếp hàng như trên.
- Goal cũ (không có trường `git`) chạy như trước; `/goal merge` báo không có git.

### Cấu hình `~/.pi/agent/goal-orch.json` (mọi khoá đều tuỳ chọn)

```json
{
  "git": "worktree",          // worktree | branch | none
  "merge": "auto",            // auto | ask
  "keepBranch": false,
  "worktreeRoot": null,       // mặc định <repoParent>/.worktrees (khi không dùng Orca)
  "orca": "auto",             // auto = dùng Orca khi CLI trả lời; off
  "orcaSetup": "inherit",     // inherit | run | skip — setup hook của repo trong Orca (vd npm install)
  "orcaAutoAddRepo": true,    // repo chưa có trong Orca thì orca repo add
  "reviewSkill": "ck-code-review",
  "fixSkill": "ck-fix",
  "maxFixLoops": 2,
  "lockStaleMinutes": 30
}
```

(File thật là JSON thuần — bỏ comment.)

### Orca (đã kiểm chứng với Orca 1.4.209 + source `stablyai/orca`)

- Dùng CLI `orca` (`$ORCA_CLI_COMMAND` → `%LOCALAPPDATA%\Programs\orca\resources\bin\orca.exe` → `orca`; Linux dùng `orca-ide`). Orca không chạy → tự quay về git worktree thường.
- Worktree tạo bằng `git worktree add` bị Orca **ẩn** mặc định (externalWorktreeVisibility = hide với repo mới), nên khi Orca chạy, goal tạo worktree qua `orca worktree create --no-parent --base-branch <base> --setup <orcaSetup> --comment …`, rồi đổi tên branch Orca sinh ra thành `goal/…` và ghim đúng commit base. Lúc merge đặt workspace-status `in-review`; xong thì `orca worktree rm`.
- Orchestration của Orca (task/dispatch) là để giám sát terminal agent, **không có merge queue** — lock/registry/merge do goal-orch tự làm.
- CLI Orca **không có `repo rm`**: repo được `orcaAutoAddRepo` thêm vào chỉ gỡ được trong Orca UI.

## Kiến trúc ngắn / Architecture notes

- **Không có `invokeSkill()`** — Pi chỉ soft-prompt: `pi.sendUserMessage` + (tuỳ chọn) đường dẫn `SKILL.md` lấy từ `pi.getCommands().filter(c => c.source === "skill")`.
- State lưu bằng `pi.appendEntry("goal-orch-state", …)` và khôi phục từ `sessionManager.getBranch()` lúc `session_start`.
- State cũ (trước khi có `modeSource`, `pauseReason`, `checkpoint`) vẫn load bình thường; các trường thiếu được gán mặc định.
- Chế độ **AFK**: sau `agent_settled` (Pi sẽ không tự chạy tiếp nữa), stage tự chuyển, trừ khi stage là checkpoint hoặc có anti-signal.
- **Anti-signal** chỉ xét **tin nhắn cuối** của stage (phần đuôi ~600 ký tự, bỏ code block / inline code / URL): dừng khi một trong 2 dòng cuối kết thúc bằng `?`, hoặc có câu xin input rõ ràng (“could you clarify”, “waiting for your input”, “I cannot proceed”, “vui lòng làm rõ/chọn”, …). Câu kiểu “chờ bạn duyệt” trong tóm tắt plan **không** làm dừng — việc duyệt là của stage checkpoint. Khi model hỏi, bạn chỉ cần trả lời; stage xong mà không hỏi thêm thì goal tự chạy tiếp.
- Chế độ **HITL**: dừng sau mỗi stage — dùng `/goal next` (hoặc `/goal auto` để thôi dừng).

## Lưu ý / Caveats

1. **Trùng lệnh `/goal`**: có thể xung đột với package khác (ví dụ `@peeraponw/pi-goal`). Pi sẽ suffix tên (`goal:1`, …) theo thứ tự load — kiểm tra bằng `/` trong editor.
2. **Soft-prompt limitation**: model *có thể* bỏ qua skill; không có API ép invoke. Nên skill rõ ràng + `SKILL.md` dễ đọc.
3. Anti-signal vẫn có thể false-positive (ví dụ báo cáo kết thúc bằng một câu hỏi tu từ). Dùng `/goal next` hoặc `/goal skip` khi cần.
4. Git: model *có thể* lỡ chạy lệnh ngoài worktree — khối Git isolation chỉ là hướng dẫn (Pi không cho đổi cwd). Review stage là chốt chặn trước khi merge.
5. `--carry` (mang thay đổi chưa commit sang worktree) chưa làm — cố ý, để không đụng việc dở của bạn.
6. Starter package — chỉnh `src/runner.ts` / `src/planner.ts` theo workflow của bạn.

## Cấu trúc / Layout

```
pi-goal-orch/
├── package.json
├── README.md
├── extensions/
│   └── index.ts      # default export factory
└── src/
    ├── types.ts
    ├── discover.ts
    ├── state.ts
    ├── planner.ts
    ├── runner.ts
    ├── commands.ts
    ├── config.ts     # goal-orch.json
    ├── git.ts        # worktree/branch, sync base, merge --no-ff, cleanup
    ├── orca.ts       # Orca CLI (tuỳ chọn)
    ├── registry.ts   # registry goal song song + merge lock
    ├── finish.ts     # review → fix → merge queue, goal_report
    └── pi-shim.d.ts  # stub types khi chưa có peer package
```

## License

MIT
