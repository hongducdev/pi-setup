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
| `/goal` / `/goal status` | Xem trạng thái goal hiện tại (`⏸` = stage checkpoint) |
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
4. Starter package — chỉnh `src/runner.ts` / `src/planner.ts` theo workflow của bạn.

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
    └── pi-shim.d.ts  # stub types khi chưa có peer package
```

## License

MIT
