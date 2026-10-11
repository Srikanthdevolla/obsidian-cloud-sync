import type { BaseFile, RemoteEntry } from "./types";
import { ancestors, basename, dirname, formatBytes } from "./util";

export interface LocalInfo { hash: string; size: number }

export type FileAction =
  | { type: "upload"; path: string; hash: string }
  | { type: "update_remote"; path: string; id: string; hash: string }
  | { type: "download"; path: string; entry: RemoteEntry; mode: "new" | "update"; baseHash: string | null }
  | { type: "delete_remote"; path: string; id: string }
  | { type: "delete_local"; path: string; baseHash: string }
  | { type: "adopt"; path: string; id: string; hash: string }
  | { type: "forget"; path: string }
  | { type: "conflict"; path: string; entry: RemoteEntry; reason: "first_sync" | "both_changed" };

export type FolderAction =
  | { type: "mkdir_local"; path: string; id: string }
  | { type: "mkdir_remote"; path: string }
  | { type: "rmdir_local"; path: string }
  | { type: "rmdir_remote"; path: string; id: string }
  | { type: "forget"; path: string };

export interface SyncPlan {
  files: FileAction[];
  folders: FolderAction[];
  foldersBoth: { path: string; id: string }[];
  skipped: { path: string; reason: string }[];
  inSync: number;
}

export interface PlanInput {
  local: Map<string, LocalInfo>;
  localFolders: Set<string>;
  remote: Map<string, RemoteEntry>;
  baseFiles: Record<string, BaseFile>;
  baseFolders: Record<string, string>;
  maxUpload: number;
}

export function isHiddenPath(p: string): boolean {
  return p.split("/").some((seg) => seg.startsWith("."));
}

// Decides, for every path, what to do. "base" is what both sides looked like at the last
// successful sync, so we can tell WHO changed something (the 3-way comparison).
// Rules: nothing is ever overwritten silently; the Drive version keeps the original name in a
// conflict and the local version is kept as a conflict copy; an edit always beats a delete.
export function planSync(a: PlanInput): SyncPlan {
  const plan: SyncPlan = { files: [], folders: [], foldersBoth: [], skipped: [], inSync: 0 };
  const { local, localFolders, remote, baseFiles, baseFolders, maxUpload } = a;

  const paths = new Set<string>();
  for (const p of local.keys()) paths.add(p);
  for (const [p, r] of remote) if (!r.isFolder) paths.add(p);
  for (const p of Object.keys(baseFiles)) paths.add(p);

  for (const p of [...paths].sort()) {
    if (isHiddenPath(p)) continue;
    const r = remote.get(p);
    if (r && r.isFolder) {
      plan.skipped.push({ path: p, reason: "a folder with this name exists on Drive" });
      continue;
    }
    if (localFolders.has(p)) {
      plan.skipped.push({ path: p, reason: "a folder with this name exists here" });
      continue;
    }
    if (r && r.native) {
      plan.skipped.push({ path: p, reason: "Google Docs-type file, not synced" });
      continue;
    }

    const l = local.get(p) ?? null;
    const Lh = l ? l.hash : null;
    const rr = r ?? null;
    const Rh = rr ? (rr.sha256 ?? `unknown:${rr.id}`) : null;
    const b = baseFiles[p];
    const hasBase = b !== undefined;
    const Bh = hasBase ? b.hash : null;

    const tooBig = l !== null && l.size > maxUpload;
    const upload = () => {
      if (tooBig) plan.skipped.push({ path: p, reason: `too large to upload (over ${formatBytes(maxUpload)})` });
      else plan.files.push({ type: "upload", path: p, hash: Lh as string });
    };

    if (Lh === null && Rh === null) {
      if (hasBase) plan.files.push({ type: "forget", path: p });
      continue;
    }

    if (!hasBase) {
      if (Lh !== null && rr === null) upload();
      else if (Lh === null && rr !== null) plan.files.push({ type: "download", path: p, entry: rr, mode: "new", baseHash: null });
      else if (Lh === Rh && rr !== null) plan.files.push({ type: "adopt", path: p, id: rr.id, hash: Lh as string });
      else plan.files.push({ type: "conflict", path: p, entry: rr as RemoteEntry, reason: "first_sync" });
      continue;
    }

    const lChanged = Lh !== Bh;
    const rChanged = Rh !== Bh;
    if (!lChanged && !rChanged) {
      plan.inSync++;
    } else if (lChanged && !rChanged) {
      if (Lh === null) plan.files.push({ type: "delete_remote", path: p, id: (rr as RemoteEntry).id });
      else if (tooBig) plan.skipped.push({ path: p, reason: `too large to upload (over ${formatBytes(maxUpload)})` });
      else plan.files.push({ type: "update_remote", path: p, id: (rr as RemoteEntry).id, hash: Lh });
    } else if (!lChanged && rChanged) {
      if (Rh === null) plan.files.push({ type: "delete_local", path: p, baseHash: b.hash });
      else plan.files.push({ type: "download", path: p, entry: rr as RemoteEntry, mode: "update", baseHash: b.hash });
    } else if (Lh === Rh && rr !== null) {
      plan.files.push({ type: "adopt", path: p, id: rr.id, hash: Lh as string });
    } else if (Lh === null) {
      // deleted here, edited on Drive: the edit wins, so bring the file back
      plan.files.push({ type: "download", path: p, entry: rr as RemoteEntry, mode: "new", baseHash: null });
    } else if (Rh === null) {
      // deleted on Drive, edited here: the edit wins, so upload it again
      upload();
    } else {
      plan.files.push({ type: "conflict", path: p, entry: rr as RemoteEntry, reason: "both_changed" });
    }
  }

  // ----- folders -----
  const remoteFolders = new Map<string, string>();
  for (const [p, r] of remote) if (r.isFolder && !isHiddenPath(p)) remoteFolders.set(p, r.id);
  const remoteHasChildren = new Set<string>();
  for (const k of remote.keys()) for (const x of ancestors(k)) remoteHasChildren.add(x);
  const localHasChildren = new Set<string>();
  for (const k of [...local.keys(), ...localFolders]) for (const x of ancestors(k)) localHasChildren.add(x);

  const fpaths = new Set<string>([...localFolders, ...remoteFolders.keys(), ...Object.keys(baseFolders)]);
  for (const p of fpaths) {
    if (isHiddenPath(p)) continue;
    const rf = remote.get(p);
    if (local.has(p) || (rf && !rf.isFolder)) continue; // name clash with a file; reported above
    const l = localFolders.has(p);
    const rid = remoteFolders.get(p);
    const wasSynced = Object.prototype.hasOwnProperty.call(baseFolders, p);
    if (l && rid) plan.foldersBoth.push({ path: p, id: rid });
    else if (l && !rid) {
      if (!wasSynced) plan.folders.push({ type: "mkdir_remote", path: p });
      else if (!localHasChildren.has(p)) plan.folders.push({ type: "rmdir_local", path: p });
    } else if (!l && rid) {
      if (!wasSynced) plan.folders.push({ type: "mkdir_local", path: p, id: rid });
      else if (!remoteHasChildren.has(p)) plan.folders.push({ type: "rmdir_remote", path: p, id: rid });
    } else if (wasSynced) plan.folders.push({ type: "forget", path: p });
  }
  return plan;
}

function cleanDevice(name: string): string {
  const c = name.replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 30);
  return c || "device";
}

// notes/a.md -> notes/a (conflict Fedora 2026-10-11 0818).md  (adds a number if that name exists)
export function conflictPath(path: string, device: string, stamp: string, exists: (p: string) => boolean): string {
  const dir = dirname(path);
  const file = basename(path);
  const dot = file.lastIndexOf(".");
  const name = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : "";
  const make = (n: number) => `${dir ? dir + "/" : ""}${name} (conflict ${cleanDevice(device)} ${stamp}${n > 1 ? " " + n : ""})${ext}`;
  let n = 1;
  while (exists(make(n))) n++;
  return make(n);
}

export function describeSyncPlan(plan: SyncPlan, problems: string[]): string {
  const count = (t: FileAction["type"]) => plan.files.filter((f) => f.type === t).length;
  const conflicts = plan.files.filter((f) => f.type === "conflict").map((f) => f.path);
  const lines = [
    "FIRST SYNC PREVIEW (nothing has been changed yet)",
    `• Will upload to Drive: ${count("upload")} file(s)`,
    `• Will download to this device: ${count("download")} file(s)`,
    `• Identical on both sides: ${count("adopt")}`,
    `• Same name but different content: ${conflicts.length}`,
  ];
  if (conflicts.length) {
    lines.push("    The Drive version keeps the name here, and YOUR version is kept as a separate");
    lines.push('    "(conflict …)" copy. Nothing is lost. Files:');
    for (const c of conflicts.slice(0, 8)) lines.push("      - " + c);
    if (conflicts.length > 8) lines.push(`      …and ${conflicts.length - 8} more`);
  }
  lines.push(`• Empty folders to create: ${plan.folders.filter((f) => f.type === "mkdir_local" || f.type === "mkdir_remote").length}`);
  if (plan.skipped.length) {
    lines.push(`• Skipped: ${plan.skipped.length}`);
    for (const s of plan.skipped.slice(0, 8)) lines.push(`      - ${s.path} (${s.reason})`);
  }
  if (problems.length) lines.push(`• Drive problems found: ${problems.length}`);
  return lines.join("\n");
}
