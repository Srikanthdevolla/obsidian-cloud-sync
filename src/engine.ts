import { App, TFile, TFolder, normalizePath } from "obsidian";
import { DriveClient, errMsg } from "./google";
import { MAX_SIMPLE_UPLOAD } from "./plan";
import { LocalInfo, SyncPlan, FileAction, conflictPath, describeSyncPlan, planSync } from "./reconcile";
import { ensureLocalFolder, ensureRemoteFolder } from "./transfer";
import { BaseFile, RemoteEntry, SyncState, blankState } from "./types";
import { basename, dirname, sha256Hex } from "./util";

const FULL_CHECK_EVERY_MS = 10 * 60 * 1000; // safety net: full comparison at least this often
const MAX_PASSES = 3;

export interface StateIO {
  load(): Promise<string | null>;
  save(json: string): Promise<void>;
  remove(): Promise<void>;
}

export interface SyncSummary { up: number; down: number; del: number; conflicts: number; skipped: number; errors: number }

export interface SyncStatus {
  state: "idle" | "syncing" | "error" | "offline";
  message: string;
  lastSuccess: number | null;
  last: SyncSummary | null;
}

export interface EngineOptions {
  app: App;
  drive: DriveClient;
  rootId: string;
  deviceName: string;
  io: StateIO;
  onStatus?: (s: SyncStatus) => void;
  maxUpload?: number;
  now?: () => Date;
  isOnline?: () => boolean;
}

interface LocalScan {
  files: Map<string, LocalInfo & { mtime: number }>;
  folders: Set<string>;
}

const pad = (n: number) => String(n).padStart(2, "0");
function stamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export class SyncEngine {
  state: SyncState;
  status: SyncStatus = { state: "idle", message: "Not started", lastSuccess: null, last: null };
  private own = new Map<string, string>(); // Drive ids we just wrote -> what we wrote (to ignore our own echoes)
  private hashCache = new Map<string, { mtime: number; size: number; hash: string }>();
  private running = false;
  private failures = 0;
  private backoffUntil = 0;
  private logLines: string[] = [];
  private readonly maxUpload: number;

  constructor(private o: EngineOptions) {
    this.state = blankState(o.rootId);
    this.maxUpload = o.maxUpload ?? MAX_SIMPLE_UPLOAD;
  }

  // ---------- state ----------
  async init(): Promise<void> {
    try {
      const raw = await this.o.io.load();
      if (raw) {
        const s = JSON.parse(raw) as SyncState;
        if (s && s.version === 1 && s.folderId === this.o.rootId && s.files && s.folders) this.state = s;
      }
    } catch (e) {
      this.log(`Could not read saved sync state, starting fresh: ${errMsg(e)}`);
    }
  }

  isInitialized(): boolean {
    return this.state.initialized;
  }

  async markInitialized(): Promise<void> {
    this.state.initialized = true;
    await this.saveState();
  }

  private async saveState(): Promise<void> {
    await this.o.io.save(JSON.stringify(this.state));
  }

  getLog(): string {
    return this.logLines.join("\n");
  }

  log(m: string): void {
    const t = new Date();
    this.logLines.push(`${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())} ${m}`);
    if (this.logLines.length > 300) this.logLines.splice(0, this.logLines.length - 300);
  }

  private setStatus(state: SyncStatus["state"], message: string, last?: SyncSummary): void {
    this.status = {
      state,
      message,
      lastSuccess: state === "idle" ? Date.now() : this.status.lastSuccess,
      last: last ?? this.status.last,
    };
    this.o.onStatus?.(this.status);
  }

  // ---------- reading this device ----------
  private async scanLocal(): Promise<LocalScan> {
    const vault = this.o.app.vault;
    const files = new Map<string, LocalInfo & { mtime: number }>();
    for (const tf of vault.getFiles()) {
      const { mtime, size } = tf.stat;
      const base = this.state.files[tf.path];
      const cached = this.hashCache.get(tf.path);
      let hash: string | null = null;
      if (base && base.mtime === mtime && base.size === size) hash = base.hash;
      else if (cached && cached.mtime === mtime && cached.size === size) hash = cached.hash;
      if (hash === null) {
        const data = await vault.readBinary(tf);
        hash = await sha256Hex(data);
        this.hashCache.set(tf.path, { mtime, size, hash });
      }
      files.set(tf.path, { hash, size, mtime });
    }
    const folders = new Set<string>();
    for (const f of vault.getAllLoadedFiles()) if (f instanceof TFolder && !f.isRoot()) folders.add(f.path);
    return { files, folders };
  }

  // Cheap check: did anything change on this device since the last sync?
  private localDiffers(scan: LocalScan): boolean {
    for (const [p, l] of scan.files) {
      const b = this.state.files[p];
      if (!b || b.mtime !== l.mtime || b.size !== l.size || b.hash !== l.hash) return true;
    }
    for (const p of Object.keys(this.state.files)) if (!scan.files.has(p)) return true;
    for (const f of scan.folders) if (!(f in this.state.folders)) return true;
    for (const f of Object.keys(this.state.folders)) if (!scan.folders.has(f)) return true;
    return false;
  }

  // ---------- Drive change feed (a cheap "did anything happen?" check) ----------
  private async poll(): Promise<{ relevant: boolean; newToken: string | null }> {
    if (!this.state.pageToken) {
      return { relevant: true, newToken: await this.o.drive.getStartPageToken() };
    }
    const { changes, newToken } = await this.o.drive.listChanges(this.state.pageToken);
    let relevant = false;
    for (const c of changes) {
      const mine = this.own.get(c.id);
      const current = c.removed || c.trashed ? "trashed" : c.folder ? "folder" : (c.sha256 ?? "?");
      if (mine !== undefined && mine === current) this.own.delete(c.id);
      else relevant = true;
    }
    return { relevant, newToken };
  }

  // ---------- first-time preview (changes nothing) ----------
  async preview(): Promise<{ plan: SyncPlan; text: string }> {
    const scan = await this.scanLocal();
    const { entries, problems } = await this.o.drive.listTree(this.o.rootId);
    const plan = planSync({
      local: scan.files,
      localFolders: scan.folders,
      remote: entries,
      baseFiles: this.state.files,
      baseFolders: this.state.folders,
      maxUpload: this.maxUpload,
    });
    return { plan, text: describeSyncPlan(plan, problems) };
  }

  // ---------- one sync run ----------
  async runOnce(opts: { force?: boolean } = {}): Promise<void> {
    if (this.running) return;
    if (!opts.force && Date.now() < this.backoffUntil) return;
    if (this.o.isOnline && !this.o.isOnline()) {
      this.setStatus("offline", "Offline. Changes are kept and will sync when you are back online.");
      return;
    }
    this.running = true;
    const total: SyncSummary = { up: 0, down: 0, del: 0, conflicts: 0, skipped: 0, errors: 0 };
    try {
      this.setStatus("syncing", "Checking for changes…");
      for (let pass = 1; pass <= MAX_PASSES; pass++) {
        const scan = await this.scanLocal();
        let remoteChanged = false;
        let newToken: string | null = this.state.pageToken;
        if (pass === 1) {
          remoteChanged = !!opts.force || Date.now() - this.state.lastFullAt > FULL_CHECK_EVERY_MS;
          try {
            const p = await this.poll();
            remoteChanged = remoteChanged || p.relevant;
            newToken = p.newToken;
          } catch (e) {
            this.log(`Change check failed, doing a full comparison instead: ${errMsg(e)}`);
            remoteChanged = true;
            newToken = null;
          }
        } else {
          remoteChanged = true; // after our own changes, verify that everything settled
        }
        if (!remoteChanged && !this.localDiffers(scan)) break;

        this.setStatus("syncing", "Syncing…");
        const { entries, problems } = await this.o.drive.listTree(this.o.rootId);
        for (const pr of problems) this.log(`Drive: ${pr}`);
        const plan = planSync({
          local: scan.files,
          localFolders: scan.folders,
          remote: entries,
          baseFiles: this.state.files,
          baseFolders: this.state.folders,
          maxUpload: this.maxUpload,
        });
        const res = await this.apply(plan, scan, entries);
        total.up += res.up; total.down += res.down; total.del += res.del;
        total.conflicts += res.conflicts; total.errors += res.errors;
        total.skipped = plan.skipped.length;
        if (pass === 1) this.state.pageToken = newToken;
        this.state.lastFullAt = Date.now();
        await this.saveState();
        if (res.applied === 0) break;
      }
      this.failures = 0;
      this.backoffUntil = 0;
      if (total.errors > 0) {
        this.setStatus("error", `${total.errors} item(s) could not be synced and will be retried.`, total);
      } else {
        this.setStatus("idle", "Up to date.", total);
      }
    } catch (e) {
      this.failures++;
      this.backoffUntil = Date.now() + Math.min(300000, 10000 * 2 ** this.failures);
      this.log(`Sync failed: ${errMsg(e)}`);
      this.setStatus("error", `Sync problem: ${errMsg(e)} Will retry.`, total);
    } finally {
      this.running = false;
    }
  }

  // ---------- applying a plan ----------
  private async apply(plan: SyncPlan, scan: LocalScan, entries: Map<string, RemoteEntry>) {
    const app = this.o.app;
    const vault = app.vault;
    const res = { applied: 0, up: 0, down: 0, del: 0, conflicts: 0, errors: 0 };
    const ids = new Map<string, string>([["", this.o.rootId]]);
    for (const [p, e] of entries) if (e.isFolder) ids.set(p, e.id);
    const knownFolderIds = new Set(ids.values());
    let sinceSave = 0;
    const fail = (p: string, e: unknown) => {
      res.errors++;
      this.log(`Failed: ${p}: ${errMsg(e)}`);
    };

    for (const f of plan.foldersBoth) this.state.folders[f.path] = f.id;

    // 1. create folders (parents first)
    const mk = plan.folders
      .filter((f) => f.type === "mkdir_local" || f.type === "mkdir_remote")
      .sort((a, b) => a.path.split("/").length - b.path.split("/").length);
    for (const f of mk) {
      try {
        if (f.type === "mkdir_local") {
          await ensureLocalFolder(app, normalizePath(f.path));
          this.state.folders[f.path] = f.id;
        } else if (f.type === "mkdir_remote") {
          this.state.folders[f.path] = await ensureRemoteFolder(this.o.drive, ids, f.path);
        }
        res.applied++;
      } catch (e) {
        fail(f.path, e);
      }
    }

    // 2. files
    const order: Record<FileAction["type"], number> = {
      conflict: 0, download: 1, delete_local: 2, delete_remote: 3, upload: 4, update_remote: 5, adopt: 6, forget: 7,
    };
    const actions = [...plan.files].sort((a, b) => order[a.type] - order[b.type]);
    for (const a of actions) {
      try {
        const did = await this.applyFile(a, scan, ids);
        if (did) {
          res.applied++;
          if (a.type === "upload" || a.type === "update_remote") res.up++;
          else if (a.type === "download") res.down++;
          else if (a.type === "delete_local" || a.type === "delete_remote") res.del++;
          else if (a.type === "conflict") res.conflicts++;
        }
      } catch (e) {
        fail(a.path, e);
      }
      if (++sinceSave % 25 === 0) await this.saveState();
    }

    // 3. remove empty folders that were removed on the other side
    const rm = plan.folders
      .filter((f) => f.type === "rmdir_local" || f.type === "rmdir_remote")
      .sort((a, b) => b.path.split("/").length - a.path.split("/").length);
    for (const f of rm) {
      try {
        if (f.type === "rmdir_local") {
          const folder = vault.getAbstractFileByPath(f.path);
          if (folder instanceof TFolder && folder.children.length === 0) {
            await vault.trash(folder, false);
            delete this.state.folders[f.path];
            res.applied++;
          }
        } else if (f.type === "rmdir_remote") {
          await this.o.drive.trash(f.id);
          this.own.set(f.id, "trashed");
          delete this.state.folders[f.path];
          res.applied++;
        }
      } catch (e) {
        fail(f.path, e);
      }
    }
    for (const f of plan.folders) if (f.type === "forget") delete this.state.folders[f.path];

    // remember folders we created, so their echo in the change feed is ignored
    for (const [p, id] of ids) {
      if (!knownFolderIds.has(id)) {
        this.own.set(id, "folder");
        this.state.folders[p] = id;
      }
    }
    return res;
  }

  private async applyFile(a: FileAction, scan: LocalScan, ids: Map<string, string>): Promise<boolean> {
    const app = this.o.app;
    const vault = app.vault;
    const drive = this.o.drive;
    const p = a.path;

    switch (a.type) {
      case "adopt": {
        const l = scan.files.get(p);
        if (!l) return false;
        this.state.files[p] = { id: a.id, hash: a.hash, mtime: l.mtime, size: l.size };
        return false;
      }
      case "forget":
        delete this.state.files[p];
        return false;

      case "upload":
      case "update_remote": {
        const tf = vault.getAbstractFileByPath(p);
        if (!(tf instanceof TFile)) return false;
        const { mtime } = tf.stat;
        const data = await vault.readBinary(tf);
        const hash = await sha256Hex(data);
        if (hash !== a.hash) {
          this.log(`Skipped ${p}: it changed while syncing; it will be picked up next time.`);
          return false;
        }
        if (data.byteLength > this.maxUpload) return false;
        let id: string;
        if (a.type === "upload") {
          const parent = await ensureRemoteFolder(drive, ids, dirname(p));
          id = (await drive.uploadFile(parent, basename(p), data, hash)).id;
        } else {
          await drive.updateFile(a.id, data, hash);
          id = a.id;
        }
        this.state.files[p] = { id, hash, mtime, size: data.byteLength };
        this.own.set(id, hash);
        this.log(`${a.type === "upload" ? "Uploaded" : "Updated on Drive"}: ${p}`);
        return true;
      }

      case "delete_remote":
        await drive.trash(a.id);
        this.own.set(a.id, "trashed");
        delete this.state.files[p];
        this.log(`Moved to Drive trash: ${p}`);
        return true;

      case "delete_local": {
        const tf = vault.getAbstractFileByPath(p);
        if (!(tf instanceof TFile)) {
          delete this.state.files[p];
          return false;
        }
        const hash = await sha256Hex(await vault.readBinary(tf));
        if (hash !== a.baseHash) {
          this.log(`Kept ${p}: it was deleted on another device but you changed it here.`);
          return false;
        }
        await vault.trash(tf, false);
        delete this.state.files[p];
        this.log(`Removed here (deleted on another device; recoverable from trash): ${p}`);
        return true;
      }

      case "download": {
        const data = await drive.download(a.entry.id);
        const hash = await sha256Hex(data);
        if (a.entry.sha256 !== null && hash !== a.entry.sha256) throw new Error("the download did not match its checksum");
        const existing = vault.getAbstractFileByPath(p);
        let tf: TFile;
        if (a.mode === "update") {
          if (!(existing instanceof TFile)) return false;
          const nowHash = await sha256Hex(await vault.readBinary(existing));
          if (nowHash !== a.baseHash) {
            this.log(`Held back ${p}: you changed it while it was being updated; it will be compared again.`);
            return false;
          }
          await vault.modifyBinary(existing, data);
          tf = existing;
        } else {
          if (existing) {
            this.log(`Held back ${p}: a local item appeared with this name.`);
            return false;
          }
          await ensureLocalFolder(app, normalizePath(dirname(p)));
          tf = await vault.createBinary(normalizePath(p), data);
        }
        const back = await vault.readBinary(tf);
        if ((await sha256Hex(back)) !== hash) throw new Error("the saved file does not match the download");
        this.state.files[p] = { id: a.entry.id, hash, mtime: tf.stat.mtime, size: data.byteLength };
        this.log(`Downloaded: ${p}`);
        return true;
      }

      case "conflict": {
        const tf = vault.getAbstractFileByPath(p);
        if (!(tf instanceof TFile)) return false;
        const data = await drive.download(a.entry.id);
        const hash = await sha256Hex(data);
        if (a.entry.sha256 !== null && hash !== a.entry.sha256) throw new Error("the download did not match its checksum");
        const copy = conflictPath(p, this.o.deviceName, stamp((this.o.now ?? (() => new Date()))()), (x) => !!vault.getAbstractFileByPath(x));
        await vault.rename(tf, copy);
        let created: TFile;
        try {
          await ensureLocalFolder(app, normalizePath(dirname(p)));
          created = await vault.createBinary(normalizePath(p), data);
        } catch (e) {
          await vault.rename(tf, p); // put the original back
          throw e;
        }
        this.state.files[p] = { id: a.entry.id, hash, mtime: created.stat.mtime, size: data.byteLength };
        this.log(`Conflict on ${p}: kept your version as "${copy}" and took the Drive version.`);
        return true;
      }
    }
  }
}
