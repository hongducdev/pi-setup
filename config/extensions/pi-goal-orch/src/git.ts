/**
 * Git isolation for goals: worktree / branch creation, base sync, merge, cleanup.
 * Rules: never push, never force, never stash/touch the user's uncommitted
 * changes in the main tree, never delete unmerged work (`git branch -d` only).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { GoalOrchConfig } from "./config.ts";
import * as orca from "./orca.ts";
import { claimedNames, normPath, upsertGoal } from "./registry.ts";
import type { GitMode, GoalGit } from "./types.ts";

export interface GitResult {
  ok: boolean;
  out: string;
  err: string;
  code: number;
}

export function git(cwd: string, args: string[], timeout = 120_000): GitResult {
  const r = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no" },
  });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || String(r.error ?? "")).trim(), code: r.status ?? -1 };
}

export function repoTop(cwd: string): string | null {
  const r = git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.ok && r.out ? path.resolve(r.out) : null;
}

/** Main working tree of the repo containing cwd (even when cwd is a linked worktree). */
export function mainTree(cwd: string): string | null {
  const r = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!r.ok) return null;
  const common = path.resolve(r.out);
  return path.basename(common) === ".git" ? path.dirname(common) : repoTop(cwd);
}

export function currentBranch(cwd: string): string | null {
  const r = git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return r.ok && r.out ? r.out : null;
}

export function headSha(cwd: string, ref = "HEAD"): string {
  return git(cwd, ["rev-parse", ref]).out;
}

/** Uncommitted (tracked or untracked, not ignored) paths. */
export function dirtyFiles(cwd: string): string[] {
  const r = git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  if (!r.ok || !r.out) return [];
  return r.out.split(/\r?\n/).map((l) => l.slice(3).replace(/^"|"$/g, "").split(" -> ").pop()!).filter(Boolean);
}

export function branchExists(cwd: string, branch: string): boolean {
  return git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

export function slugify(text: string): string {
  const s = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return s || "goal";
}

export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export interface SetupResult {
  git?: GoalGit;
  /** human-readable notes for the start message */
  notes: string[];
  /** refused: reason (goal must not start) */
  error?: string;
}

/**
 * Prepare isolation for a new goal. `mode` = requested/configured mode.
 * Not in a git repo → no isolation (notes explain). Never touches the main tree's changes.
 */
export function setupIsolation(cwd: string, goal: string, mode: GitMode, cfg: GoalOrchConfig): SetupResult {
  const notes: string[] = [];
  if (mode === "none") return { notes: ["Git: --no-git (không quản lý branch/worktree)."] };
  const top = repoTop(cwd);
  if (!top) return { notes: ["Git: thư mục hiện tại không phải git repo — chạy không isolation."] };
  const main = mainTree(cwd) ?? top;
  const base = currentBranch(top);
  if (!base) {
    return { notes: [], error: "HEAD đang detached — checkout một branch rồi chạy lại, hoặc dùng `/goal --no-git …`." };
  }
  if (!git(top, ["rev-parse", "--verify", "HEAD"]).ok) {
    return { notes: [], error: "Repo chưa có commit nào — tạo commit đầu tiên hoặc dùng `--no-git`." };
  }
  const baseSha = headSha(top);
  const dirty = dirtyFiles(top);
  const slug = slugify(goal);
  const ts = stamp();
  const claimed = claimedNames(main);
  let branch = `goal/${slug}-${ts}`;
  for (let i = 2; branchExists(top, branch) || claimed.branches.has(branch); i++) branch = `goal/${slug}-${ts}-${i}`;
  const id = `${normPath(main)}#${branch}`;

  if (mode === "branch") {
    if (dirty.length) {
      return {
        notes: [],
        error: `Working tree có ${dirty.length} file chưa commit — branch mode sẽ trộn chúng vào goal. Commit/stash trước, hoặc dùng worktree mode (mặc định, không đụng thay đổi của bạn).`,
      };
    }
    if (claimed.workdirs.has(normPath(top))) {
      return { notes: [], error: "Một goal khác đang dùng chính working tree này (branch mode). Dùng worktree mode để chạy song song." };
    }
    const r = git(top, ["switch", "-c", branch]);
    if (!r.ok) return { notes: [], error: `git switch -c thất bại: ${r.err}` };
    const g: GoalGit = { mode: "branch", repo: main, workdir: top, branch, base, baseSha, id, fixLoops: 0, previousBranch: base };
    register(g, goal);
    notes.push(`Git: branch mode — đã tạo và checkout \`${branch}\` (từ \`${base}\`) trong ${top}.`);
    return { git: g, notes };
  }

  // ---- worktree mode ----
  let workdir: string | undefined;
  let orcaId: string | undefined;
  let orcaRepoId: string | undefined;
  if (cfg.orca === "auto" && orca.orcaRunning()) {
    orcaRepoId = orca.findOrcaRepo(main) ?? undefined;
    if (!orcaRepoId && cfg.orcaAutoAddRepo) {
      const added = orca.addOrcaRepo(main);
      if (added.id) {
        orcaRepoId = added.id;
        notes.push(`Orca: đã thêm repo ${main} vào Orca.`);
      } else notes.push(`Orca: không thêm được repo (${added.error ?? "?"}) — dùng git worktree thường.`);
    }
    if (orcaRepoId) {
      const name = `goal-${slug}-${ts}`;
      const c = orca.createOrcaWorktree({ repoId: orcaRepoId, name, base, comment: `pi /goal: ${goal}`, setup: cfg.orcaSetup });
      if (c.wt) {
        const wtPath = path.resolve(c.wt.path);
        // Orca names its own branch; rename to our convention and pin to the exact base commit.
        const cur = currentBranch(wtPath);
        const okBase = headSha(wtPath) === baseSha || (dirtyFiles(wtPath).length === 0 && git(wtPath, ["reset", "--hard", baseSha]).ok);
        const renamed = cur ? git(wtPath, ["branch", "-m", cur, branch]).ok : git(wtPath, ["switch", "-c", branch]).ok;
        if (okBase && renamed) {
          workdir = wtPath;
          orcaId = c.wt.id;
          notes.push(`Orca: worktree tạo qua Orca (hiện trong Orca UI), setup=${cfg.orcaSetup}.`);
        } else {
          notes.push("Orca: worktree Orca không khớp base/branch — gỡ và dùng git worktree thường.");
          orca.removeOrcaWorktree(c.wt.id);
        }
      } else notes.push(`Orca: tạo worktree thất bại (${c.error}) — dùng git worktree thường.`);
    }
  } else if (cfg.orca === "auto") {
    notes.push("Orca: không chạy / không có CLI — dùng git worktree thường.");
  }

  if (!workdir) {
    const root = cfg.worktreeRoot ? path.resolve(cfg.worktreeRoot) : path.join(path.dirname(main), ".worktrees");
    let dir = path.join(root, `${path.basename(main)}-goal-${slug}-${ts}`);
    for (let i = 2; fs.existsSync(dir) || claimed.workdirs.has(normPath(dir)); i++) dir = path.join(root, `${path.basename(main)}-goal-${slug}-${ts}-${i}`);
    fs.mkdirSync(root, { recursive: true });
    const r = git(top, ["worktree", "add", "-b", branch, dir, baseSha]);
    if (!r.ok) {
      return { notes, error: `git worktree add thất bại: ${r.err}. Thử \`/goal --branch …\` (cần working tree sạch).` };
    }
    workdir = path.resolve(dir);
    orcaId = undefined;
  }
  const g: GoalGit = { mode: "worktree", repo: main, workdir, branch, base, baseSha, id, fixLoops: 0, orcaId, orcaRepoId };
  register(g, goal);
  notes.unshift(`Git: worktree mode — branch \`${branch}\` từ \`${base}\` (${baseSha.slice(0, 7)}) tại ${workdir}.`);
  if (dirty.length) {
    notes.push(`⚠ Main tree có ${dirty.length} file chưa commit — KHÔNG có trong worktree và không bị đụng tới (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", …" : ""}).`);
  }
  return { git: g, notes };
}

function register(g: GoalGit, goal: string) {
  upsertGoal({ id: g.id, repo: g.repo, branch: g.branch, workdir: g.workdir, base: g.base, goal, status: "active", files: [] });
}

/** Files changed on the goal branch vs base (committed + uncommitted in the workdir). */
export function changedFiles(g: GoalGit): string[] {
  const set = new Set<string>();
  const mb = git(g.workdir, ["merge-base", g.base, "HEAD"]);
  const from = mb.ok ? mb.out : g.baseSha;
  const d = git(g.workdir, ["diff", "--name-only", `${from}..HEAD`]);
  if (d.ok && d.out) d.out.split(/\r?\n/).forEach((f) => set.add(f));
  if (fs.existsSync(g.workdir)) dirtyFiles(g.workdir).forEach((f) => set.add(f));
  return [...set].sort();
}

export function commitsAhead(g: GoalGit): number {
  const r = git(g.workdir, ["rev-list", "--count", `${g.base}..${g.branch}`]);
  return r.ok ? Number(r.out) || 0 : 0;
}

export type SyncResult =
  | { kind: "up-to-date" }
  | { kind: "synced"; newBase: string }
  | { kind: "conflict"; files: string[] }
  | { kind: "error"; message: string };

/** Merge the latest base into the goal branch (inside the goal workdir). */
export function syncWithBase(g: GoalGit): SyncResult {
  const baseTip = headSha(g.repo, `refs/heads/${g.base}`);
  if (!baseTip) return { kind: "error", message: `base branch ${g.base} không tồn tại` };
  if (git(g.workdir, ["merge-base", "--is-ancestor", baseTip, "HEAD"]).ok) return { kind: "up-to-date" };
  if (dirtyFiles(g.workdir).length) return { kind: "error", message: `goal workdir có thay đổi chưa commit — commit trước khi merge` };
  const r = git(g.workdir, ["merge", "--no-ff", "--no-edit", "-m", `Merge ${g.base} into ${g.branch}`, baseTip]);
  if (r.ok) return { kind: "synced", newBase: baseTip };
  const conflicts = git(g.workdir, ["diff", "--name-only", "--diff-filter=U"]).out.split(/\r?\n/).filter(Boolean);
  git(g.workdir, ["merge", "--abort"]);
  return conflicts.length ? { kind: "conflict", files: conflicts } : { kind: "error", message: r.err || r.out };
}

export type MergeResult =
  | { kind: "merged"; sha: string }
  | { kind: "refused"; message: string }
  | { kind: "conflict"; files: string[]; message: string };

/**
 * Merge goal branch into base with --no-ff in the main tree.
 * Worktree mode: main tree must have base checked out; git refuses when the
 * merge would overwrite the user's uncommitted files → reported, nothing lost.
 * Branch mode: switches the (clean) tree back to base first.
 */
export function mergeIntoBase(g: GoalGit, goal: string): MergeResult {
  if (g.mode === "branch") {
    if (dirtyFiles(g.workdir).length) return { kind: "refused", message: "working tree có thay đổi chưa commit — commit rồi `/goal merge`." };
    const sw = git(g.workdir, ["switch", g.base]);
    if (!sw.ok) return { kind: "refused", message: `git switch ${g.base} thất bại: ${sw.err}` };
  } else {
    const cur = currentBranch(g.repo);
    if (cur !== g.base) {
      return { kind: "refused", message: `main tree (${g.repo}) đang ở \`${cur ?? "detached"}\`, không phải base \`${g.base}\` — checkout \`${g.base}\` rồi \`/goal merge\`.` };
    }
    if (fs.existsSync(path.join(g.repo, ".git", "MERGE_HEAD"))) {
      return { kind: "refused", message: "main tree đang có merge dở dang — xử lý xong rồi `/goal merge`." };
    }
  }
  const msg = `Merge ${g.branch}: ${goal.replace(/\s+/g, " ").slice(0, 72)}`;
  const r = git(g.repo, ["merge", "--no-ff", "--no-edit", "-m", msg, g.branch]);
  if (r.ok) return { kind: "merged", sha: headSha(g.repo) };
  const text = `${r.out}\n${r.err}`;
  const conflicts = git(g.repo, ["diff", "--name-only", "--diff-filter=U"]).out.split(/\r?\n/).filter(Boolean);
  if (fs.existsSync(path.join(g.repo, ".git", "MERGE_HEAD"))) git(g.repo, ["merge", "--abort"]);
  if (g.mode === "branch") git(g.workdir, ["switch", g.branch]);
  if (conflicts.length) return { kind: "conflict", files: conflicts, message: "merge conflict — đã `git merge --abort`." };
  if (/would be overwritten|untracked working tree files/i.test(text)) {
    return { kind: "refused", message: `merge sẽ ghi đè thay đổi chưa commit của bạn trong main tree — git đã từ chối, không có gì bị đụng. Commit/stash các file đó rồi \`/goal merge\`.\n${text.trim().slice(0, 400)}` };
  }
  return { kind: "refused", message: `git merge thất bại: ${text.trim().slice(0, 400)}` };
}

/** After merge: remove worktree (Orca or git, never forced) and delete the merged branch (-d). */
export function cleanup(g: GoalGit, keepBranch: boolean): string[] {
  const notes: string[] = [];
  if (g.mode === "worktree" && fs.existsSync(g.workdir)) {
    if (dirtyFiles(g.workdir).length) {
      notes.push(`Worktree ${g.workdir} còn thay đổi chưa commit — giữ lại (không xoá).`);
      return notes;
    }
    let removed = false;
    if (g.orcaId) {
      const r = orca.removeOrcaWorktree(g.orcaId);
      removed = r.ok && !fs.existsSync(g.workdir);
      if (!r.ok) notes.push(`Orca worktree rm thất bại (${r.error}) — thử git worktree remove.`);
    }
    if (!removed && fs.existsSync(g.workdir)) {
      const r = git(g.repo, ["worktree", "remove", g.workdir]);
      if (!r.ok) {
        notes.push(`git worktree remove thất bại: ${r.err}`);
        return notes;
      }
    }
    git(g.repo, ["worktree", "prune"]);
    notes.push(`Đã xoá worktree ${g.workdir}.`);
  }
  if (!keepBranch && branchExists(g.repo, g.branch)) {
    const r = git(g.repo, ["branch", "-d", g.branch]);
    notes.push(r.ok ? `Đã xoá branch \`${g.branch}\` (đã merge).` : `Giữ branch \`${g.branch}\`: ${r.err}`);
  } else if (keepBranch) notes.push(`Giữ branch \`${g.branch}\` (keepBranch).`);
  return notes;
}
