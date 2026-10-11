import { Platform, Plugin, TAbstractFile } from "obsidian";
import { Credentials, PluginData, defaultData } from "./types";
import { DriveSyncSettingTab } from "./settings";
import { DriveAuth, DriveClient } from "./google";
import { StateIO, SyncEngine, SyncStatus } from "./engine";

export default class DriveVaultSyncPlugin extends Plugin {
  data: PluginData = defaultData();
  engine: SyncEngine | null = null;
  status: SyncStatus = { state: "idle", message: "Automatic sync is off.", lastSuccess: null, last: null };
  onStatusChange: (() => void) | null = null;
  private engineFolder = "";
  private statusBar: HTMLElement | null = null;
  private running = false;
  private rerun = false;
  private timer: number | null = null;
  private ready = false;

  async onload() {
    const saved = (await this.loadData()) as Partial<PluginData> | null;
    const base = defaultData();
    this.data = {
      credentials: saved?.credentials ?? null,
      draft: { ...base.draft, ...(saved?.draft ?? {}) },
      autoSync: saved?.autoSync ?? false,
      deviceName: saved?.deviceName ?? "",
    };
    if (!this.data.deviceName) {
      this.data.deviceName = `${Platform.isMobile ? "mobile" : "desktop"}-${Math.random().toString(16).slice(2, 6)}`;
      await this.savePluginData();
    }
    this.addSettingTab(new DriveSyncSettingTab(this.app, this));
    this.statusBar = this.addStatusBarItem();
    this.renderStatusBar();

    this.app.workspace.onLayoutReady(() => {
      this.ready = true;
      const onLocal = (f: TAbstractFile) => {
        if (f.path.split("/").some((seg) => seg.startsWith("."))) return;
        this.requestSync(5000);
      };
      this.registerEvent(this.app.vault.on("create", onLocal));
      this.registerEvent(this.app.vault.on("modify", onLocal));
      this.registerEvent(this.app.vault.on("delete", onLocal));
      this.registerEvent(this.app.vault.on("rename", (f) => onLocal(f)));
      // Checking Drive is one small request, so this is cheap. Phones poll less often to save battery.
      this.registerInterval(window.setInterval(() => this.requestSync(0), Platform.isMobile ? 60000 : 30000));
      this.registerDomEvent(window, "online", () => this.requestSync(1000));
      this.registerDomEvent(document, "visibilitychange", () => {
        if (document.visibilityState === "visible") this.requestSync(1500); // catch up when the app comes back
      });
      if (this.data.autoSync) this.requestSync(2000);
    });
  }

  onunload() {
    if (this.timer !== null) window.clearTimeout(this.timer);
  }

  async savePluginData() {
    await this.saveData(this.data);
  }

  async connect(cred: Credentials) {
    this.data.credentials = cred;
    this.engine = null;
    await this.savePluginData();
  }

  async disconnect() {
    this.data.autoSync = false;
    this.data.credentials = null;
    this.engine = null;
    await this.savePluginData();
    try {
      const path = this.statePath();
      if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
    } catch {
      /* nothing to remove */
    }
    this.status = { state: "idle", message: "Automatic sync is off.", lastSuccess: null, last: null };
    this.renderStatusBar();
  }

  private statePath(): string {
    return `${this.manifest.dir}/sync-state.json`;
  }

  async ensureEngine(): Promise<SyncEngine | null> {
    const c = this.data.credentials;
    if (!c) return null;
    if (this.engine && this.engineFolder === c.folderId) return this.engine;
    const adapter = this.app.vault.adapter;
    const path = this.statePath();
    const io: StateIO = {
      load: async () => ((await adapter.exists(path)) ? adapter.read(path) : null),
      save: (json) => adapter.write(path, json),
      remove: async () => {
        if (await adapter.exists(path)) await adapter.remove(path);
      },
    };
    const engine = new SyncEngine({
      app: this.app,
      drive: new DriveClient(new DriveAuth(c)),
      rootId: c.folderId,
      deviceName: this.data.deviceName,
      io,
      onStatus: (s) => {
        this.status = s;
        this.renderStatusBar();
        this.onStatusChange?.();
      },
      isOnline: () => navigator.onLine !== false,
    });
    await engine.init();
    this.engine = engine;
    this.engineFolder = c.folderId;
    return engine;
  }

  async setAutoSync(on: boolean) {
    this.data.autoSync = on;
    await this.savePluginData();
    if (on) this.requestSync(0);
    else {
      this.status = { state: "idle", message: "Automatic sync is off.", lastSuccess: null, last: null };
      this.renderStatusBar();
      this.onStatusChange?.();
    }
  }

  requestSync(delayMs: number) {
    if (!this.ready || !this.data.autoSync || !this.data.credentials) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.runLoop(false);
    }, delayMs);
  }

  async syncNow() {
    if (!this.data.credentials) return;
    await this.runLoop(true);
  }

  private async runLoop(force: boolean) {
    if (this.running) {
      this.rerun = true;
      return;
    }
    const engine = await this.ensureEngine();
    if (!engine) return;
    this.running = true;
    try {
      let first = true;
      do {
        this.rerun = false;
        await engine.runOnce({ force: force && first });
        first = false;
      } while (this.rerun);
    } finally {
      this.running = false;
    }
  }

  private renderStatusBar() {
    if (!this.statusBar) return;
    if (!this.data.autoSync) return this.statusBar.setText("");
    const s = this.status;
    const text =
      s.state === "syncing" ? "Drive: syncing…" :
      s.state === "offline" ? "Drive: offline" :
      s.state === "error" ? "Drive: problem" : "Drive: synced";
    this.statusBar.setText(text);
  }
}
