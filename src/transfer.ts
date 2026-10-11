import { App, TFile, TFolder, normalizePath } from "obsidian";
import { DriveClient, errMsg } from "./google";
import { BackupPlan, DownloadPlan, LocalFile } from "./plan";
import { RemoteEntry, RunResult } from "./types";
import { basename, dirname, sha256Hex } from "./util";

type Progress = (msg: string) => void;

// ---------- Reading this device ----------
export async function scanLocal(app: App, progress: Progress): Promise<{ files: LocalFile[]; folders: string[] }> {
  const tfiles = app.vault.getFiles();
  const files: LocalFile[] = [];
  for (let i = 0; i < tfiles.length; i++) {
    if (i % 10 === 0 || i === tfiles.length - 1) progress(`Reading this vault… ${i + 1}/${tfiles.length}`);
    const data = await app.vault.readBinary(tfiles[i]);
    files.push({ path: tfiles[i].path, size: data.byteLength, sha256: await sha256Hex(data) });
  }
  const folders = app.vault
    .getAllLoadedFiles()
    .filter((x): x is TFolder => x instanceof TFolder && !x.isRoot())
    .map((x) => x.path);
  return { files, folders };
}

export async function ensureLocalFolder(app: App, path: string): Promise<void> {
  if (!path) return;
  let cur = "";
  for (const part of path.split("/")) {
    cur = cur ? `${cur}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(cur)) await app.vault.createFolder(cur);
  }
}

export async function ensureRemoteFolder(drive: DriveClient, ids: Map<string, string>, path: string): Promise<string> {
  const known = ids.get(path);
  if (known !== undefined) return known;
  const parentId = await ensureRemoteFolder(drive, ids, dirname(path));
  const f = await drive.createFolder(basename(path), parentId);
  ids.set(path, f.id);
  return f.id;
}

// ---------- Backup: this device -> Drive (never changes or deletes anything on Drive) ----------
export async function executeBackup(
  app: App,
  drive: DriveClient,
  rootId: string,
  plan: BackupPlan,
  remote: Map<string, RemoteEntry>,
  progress: Progress
): Promise<RunResult> {
  const result: RunResult = { done: 0, failed: [], verified: 0, notes: [] };
  const ids = new Map<string, string>([["", rootId]]);
  for (const [p, e] of remote) if (e.isFolder) ids.set(p, e.id);

  for (let i = 0; i < plan.foldersToCreate.length; i++) {
    const p = plan.foldersToCreate[i];
    progress(`Creating folders… ${i + 1}/${plan.foldersToCreate.length}`);
    try {
      await ensureRemoteFolder(drive, ids, p);
    } catch (e) {
      result.failed.push({ path: p, error: errMsg(e) });
    }
  }

  const uploaded: { path: string; sha256: string }[] = [];
  for (let i = 0; i < plan.upload.length; i++) {
    const f = plan.upload[i];
    progress(`Uploading ${i + 1}/${plan.upload.length}: ${f.path}`);
    try {
      const tf = app.vault.getAbstractFileByPath(f.path);
      if (!(tf instanceof TFile)) throw new Error("the file no longer exists here");
      const data = await app.vault.readBinary(tf);
      const hash = await sha256Hex(data);
      if (hash !== f.sha256) throw new Error("changed since the scan; scan again");
      const parentId = await ensureRemoteFolder(drive, ids, dirname(f.path));
      await drive.uploadFile(parentId, basename(f.path), data, hash);
      uploaded.push({ path: f.path, sha256: hash });
      result.done++;
    } catch (e) {
      result.failed.push({ path: f.path, error: errMsg(e) });
    }
  }

  progress("Verifying what is on Drive…");
  try {
    const { entries, problems } = await drive.listTree(rootId);
    for (const u of uploaded) {
      const r = entries.get(u.path);
      if (r && !r.isFolder && r.sha256 === u.sha256) result.verified++;
      else result.failed.push({ path: u.path, error: "not found or different on Drive after upload" });
    }
    for (const pr of problems) result.notes.push(pr);
  } catch (e) {
    result.notes.push(`Could not verify: ${errMsg(e)}`);
  }
  return result;
}

// ---------- Download: Drive -> this device (never overwrites or deletes local files) ----------
export async function executeDownload(
  app: App,
  drive: DriveClient,
  plan: DownloadPlan,
  progress: Progress
): Promise<RunResult> {
  const result: RunResult = { done: 0, failed: [], verified: 0, notes: [] };

  for (const p of plan.foldersToCreate) {
    try {
      await ensureLocalFolder(app, normalizePath(p));
    } catch (e) {
      result.failed.push({ path: p, error: errMsg(e) });
    }
  }

  for (let i = 0; i < plan.download.length; i++) {
    const r = plan.download[i];
    progress(`Downloading ${i + 1}/${plan.download.length}: ${r.path}`);
    try {
      const path = normalizePath(r.path);
      const data = await drive.download(r.id);
      const hash = await sha256Hex(data);
      if (r.sha256 !== null && hash !== r.sha256) throw new Error("the download did not match its checksum");
      if (app.vault.getAbstractFileByPath(path)) throw new Error("a local item appeared with this name; not overwritten");
      await ensureLocalFolder(app, dirname(path));
      const tf = await app.vault.createBinary(path, data);
      const back = await app.vault.readBinary(tf);
      if ((await sha256Hex(back)) !== hash) throw new Error("the saved file does not match the download");
      result.done++;
      if (r.sha256 !== null) result.verified++;
      else result.notes.push(`${r.path} was saved but has no Drive checksum to compare`);
    } catch (e) {
      result.failed.push({ path: r.path, error: errMsg(e) });
    }
  }
  return result;
}
