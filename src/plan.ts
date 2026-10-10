import type { RemoteEntry } from "./types";
import { ancestors, formatBytes } from "./util";

export const MAX_SIMPLE_UPLOAD = 5 * 1024 * 1024; // Drive's simple upload limit (5 MB)

export interface LocalFile { path: string; size: number; sha256: string }
export interface Conflict { path: string; reason: string }

export interface BackupPlan {
  upload: LocalFile[];
  foldersToCreate: string[];
  same: number;
  conflicts: Conflict[];
  tooLarge: LocalFile[];
  remoteOnly: number;
}

export interface DownloadPlan {
  download: RemoteEntry[];
  foldersToCreate: string[];
  same: number;
  conflicts: Conflict[];
  skipped: Conflict[];
  localOnly: number;
}

const depth = (p: string) => p.split("/").length;

function blockedByRemoteFile(path: string, remote: Map<string, RemoteEntry>): string | null {
  for (const a of ancestors(path)) {
    const r = remote.get(a);
    if (r && !r.isFolder) return a;
  }
  return null;
}

export function planBackup(
  files: LocalFile[],
  folders: string[],
  remote: Map<string, RemoteEntry>,
  maxUpload: number
): BackupPlan {
  const plan: BackupPlan = { upload: [], foldersToCreate: [], same: 0, conflicts: [], tooLarge: [], remoteOnly: 0 };
  const localPaths = new Set<string>([...files.map((f) => f.path), ...folders]);

  for (const f of files) {
    const blocker = blockedByRemoteFile(f.path, remote);
    if (blocker) {
      plan.conflicts.push({ path: f.path, reason: `"${blocker}" is a file on Drive, not a folder` });
      continue;
    }
    const r = remote.get(f.path);
    if (!r) {
      if (f.size > maxUpload) plan.tooLarge.push(f);
      else plan.upload.push(f);
      continue;
    }
    if (r.isFolder) {
      plan.conflicts.push({ path: f.path, reason: "a folder with this name exists on Drive" });
    } else if (r.native) {
      plan.conflicts.push({ path: f.path, reason: "a Google Docs-type file with this name exists on Drive" });
    } else if (r.sha256 === null) {
      plan.conflicts.push({ path: f.path, reason: "the Drive copy has no checksum, so it cannot be compared" });
    } else if (r.sha256 === f.sha256) {
      plan.same++;
    } else {
      plan.conflicts.push({ path: f.path, reason: "different content on Drive; left unchanged" });
    }
  }

  for (const p of folders) {
    const blocker = blockedByRemoteFile(p, remote);
    if (blocker) {
      plan.conflicts.push({ path: p, reason: `"${blocker}" is a file on Drive, not a folder` });
      continue;
    }
    const r = remote.get(p);
    if (!r) plan.foldersToCreate.push(p);
    else if (!r.isFolder) plan.conflicts.push({ path: p, reason: "a file with this name exists on Drive" });
  }
  plan.foldersToCreate.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));

  for (const p of remote.keys()) if (!localPaths.has(p)) plan.remoteOnly++;
  return plan;
}

export function planDownload(
  localFiles: Map<string, LocalFile>,
  localFolders: Set<string>,
  remote: Map<string, RemoteEntry>
): DownloadPlan {
  const plan: DownloadPlan = { download: [], foldersToCreate: [], same: 0, conflicts: [], skipped: [], localOnly: 0 };
  const paths = [...remote.keys()].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));

  for (const p of paths) {
    const r = remote.get(p) as RemoteEntry;
    if (p.split("/").some((seg) => seg.startsWith("."))) {
      plan.skipped.push({ path: p, reason: "hidden or system path" });
      continue;
    }
    if (ancestors(p).some((a) => localFiles.has(a))) {
      plan.conflicts.push({ path: p, reason: "a local file blocks this folder path" });
      continue;
    }
    if (r.isFolder) {
      if (localFiles.has(p)) plan.conflicts.push({ path: p, reason: "a local file has this folder's name" });
      else if (!localFolders.has(p)) plan.foldersToCreate.push(p);
      continue;
    }
    if (r.native) {
      plan.skipped.push({ path: p, reason: "Google Docs-type file, cannot be downloaded as a note" });
      continue;
    }
    if (localFolders.has(p)) {
      plan.conflicts.push({ path: p, reason: "a local folder has this file's name" });
      continue;
    }
    const lf = localFiles.get(p);
    if (!lf) {
      plan.download.push(r);
    } else if (r.sha256 !== null && r.sha256 === lf.sha256) {
      plan.same++;
    } else if (r.sha256 === null) {
      plan.conflicts.push({ path: p, reason: "the Drive copy has no checksum, so it cannot be compared" });
    } else {
      plan.conflicts.push({ path: p, reason: "different content on this device; left unchanged" });
    }
  }

  for (const p of [...localFiles.keys(), ...localFolders]) if (!remote.has(p)) plan.localOnly++;
  return plan;
}

function list(items: string[], max = 8): string {
  const shown = items.slice(0, max).map((s) => "      - " + s);
  if (items.length > max) shown.push(`      …and ${items.length - max} more`);
  return shown.join("\n");
}

export function describeBackup(plan: BackupPlan, problems: string[]): string {
  const bytes = plan.upload.reduce((s, f) => s + f.size, 0);
  const lines = [
    "BACKUP SUMMARY (nothing has been changed yet)",
    `• To upload: ${plan.upload.length} file(s), ${formatBytes(bytes)}`,
    `• Folders to create on Drive: ${plan.foldersToCreate.length}`,
    `• Already on Drive and identical: ${plan.same}`,
    `• Different on Drive, will NOT be changed: ${plan.conflicts.length}`,
  ];
  if (plan.conflicts.length) lines.push(list(plan.conflicts.map((c) => `${c.path} (${c.reason})`)));
  lines.push(`• Too large for now (over ${formatBytes(MAX_SIMPLE_UPLOAD)}): ${plan.tooLarge.length}`);
  if (plan.tooLarge.length) lines.push(list(plan.tooLarge.map((f) => `${f.path} (${formatBytes(f.size)})`)));
  lines.push(`• On Drive only, not in this vault: ${plan.remoteOnly}`);
  if (problems.length) {
    lines.push(`• Drive problems found: ${problems.length}`);
    lines.push(list(problems));
  }
  return lines.join("\n");
}

export function describeDownload(plan: DownloadPlan, problems: string[]): string {
  const bytes = plan.download.reduce((s, r) => s + r.size, 0);
  const lines = [
    "DOWNLOAD SUMMARY (nothing has been changed yet)",
    `• To download: ${plan.download.length} file(s), about ${formatBytes(bytes)}`,
    `• Folders to create here: ${plan.foldersToCreate.length}`,
    `• Already here and identical: ${plan.same}`,
    `• Different on this device, will NOT be changed: ${plan.conflicts.length}`,
  ];
  if (plan.conflicts.length) lines.push(list(plan.conflicts.map((c) => `${c.path} (${c.reason})`)));
  lines.push(`• Skipped: ${plan.skipped.length}`);
  if (plan.skipped.length) lines.push(list(plan.skipped.map((c) => `${c.path} (${c.reason})`)));
  lines.push(`• Only on this device, not on Drive: ${plan.localOnly}`);
  if (problems.length) {
    lines.push(`• Drive problems found: ${problems.length}`);
    lines.push(list(problems));
  }
  return lines.join("\n");
}

export function describeResult(title: string, done: number, verified: number, failed: { path: string; error: string }[], notes: string[]): string {
  const lines = [title, `• Completed: ${done}`, `• Verified: ${verified}`, `• Failed: ${failed.length}`];
  if (failed.length) lines.push(list(failed.map((f) => `${f.path} (${f.error})`), 10));
  for (const n of notes) lines.push(`• ${n}`);
  return lines.join("\n");
}
