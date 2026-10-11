import { App, PluginSettingTab, Setting, ToggleComponent } from "obsidian";
import type DriveVaultSyncPlugin from "./main";
import { Credentials } from "./types";
import {
  DeviceCode, DriveAuth, DriveClient, FlowControl,
  errMsg, pollForToken, startDeviceFlow,
} from "./google";
import { createConnectionCode, describeCode, readConnectionCode } from "./crypto";
import {
  BackupPlan, DownloadPlan, MAX_SIMPLE_UPLOAD, LocalFile,
  describeBackup, describeDownload, describeResult, planBackup, planDownload,
} from "./plan";
import { executeBackup, executeDownload, scanLocal } from "./transfer";
import { RemoteEntry } from "./types";

export class DriveSyncSettingTab extends PluginSettingTab {
  plugin: DriveVaultSyncPlugin;
  private statusEl!: HTMLElement;
  private deviceEl!: HTMLElement;
  private codeBox: HTMLTextAreaElement | null = null;
  private flow: FlowControl | null = null;
  private inlineEl: HTMLElement | null = null;
  private syncStatusEl: HTMLElement | null = null;
  private enableEl!: HTMLElement;
  private autoToggle: ToggleComponent | null = null;
  private connectCodeEl: HTMLTextAreaElement | null = null;
  private connectPassEl: HTMLInputElement | null = null;
  private createPassEl: HTMLInputElement | null = null;
  private busy = false;
  private reportEl!: HTMLElement;
  private actionEl!: HTMLElement;

  constructor(app: App, plugin: DriveVaultSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  hide(): void {
    if (this.flow) this.flow.cancelled = true;
    this.plugin.onStatusChange = null;
  }

  display(): void {
    const el = this.containerEl;
    el.empty();
    new Setting(el).setName("Drive Vault Sync").setHeading();
    this.statusEl = el.createDiv({ cls: "dvs-status" });
    if (this.plugin.data.credentials) this.renderConnected(el);
    else this.renderDisconnected(el);
  }

  private setStatus(text: string) {
    this.statusEl.setText(text);
    if (this.inlineEl && this.inlineEl.isConnected) this.inlineEl.setText(text);
  }

  private addShowToggle(setting: Setting, input: HTMLInputElement) {
    setting.addExtraButton((b) =>
      b.setIcon("eye").setTooltip("Show or hide what you typed").onClick(() => {
        input.type = input.type === "password" ? "text" : "password";
      })
    );
  }

  // ---------- Not connected ----------
  private renderDisconnected(el: HTMLElement) {
    const draft = this.plugin.data.draft;
    if (!draft.folderName) draft.folderName = this.app.vault.getName();

    new Setting(el).setName("First device: sign in with Google").setHeading();

    new Setting(el).setName("Google client ID").addText((t) =>
      t.setValue(draft.clientId).onChange(async (v) => {
        draft.clientId = v.trim();
        await this.plugin.savePluginData();
      })
    );
    new Setting(el).setName("Google client secret").addText((t) => {
      t.inputEl.type = "password";
      t.setValue(draft.clientSecret).onChange(async (v) => {
        draft.clientSecret = v.trim();
        await this.plugin.savePluginData();
      });
    });
    new Setting(el)
      .setName("Drive folder name")
      .setDesc("A folder with this name is created in your Google Drive.")
      .addText((t) =>
        t.setValue(draft.folderName).onChange(async (v) => {
          draft.folderName = v.trim();
          await this.plugin.savePluginData();
        })
      );
    new Setting(el).addButton((b) =>
      b.setButtonText("Sign in with Google").setCta().onClick(() => this.signIn())
    );
    this.deviceEl = el.createDiv({ cls: "dvs-device" });
    this.deviceEl.hide();

    new Setting(el).setName("Another device: use a connection code").setHeading();
    new Setting(el).setName("Connection code").addTextArea((t) => {
      t.setPlaceholder("DVS2.…");
      t.inputEl.rows = 4;
      this.connectCodeEl = t.inputEl;
    });
    const passSetting = new Setting(el).setName("Passphrase").addText((t) => {
      t.inputEl.type = "password";
      t.inputEl.autocomplete = "off";
      this.connectPassEl = t.inputEl;
    });
    this.addShowToggle(passSetting, this.connectPassEl as unknown as HTMLInputElement);
    new Setting(el).addButton((b) =>
      b.setButtonText("Connect this device").setCta().onClick(() => this.connectWithCode())
    );
    this.inlineEl = el.createDiv({ cls: "dvs-status" });
  }

  private showCode(dc: DeviceCode) {
    const box = this.deviceEl;
    box.empty();
    box.show();
    box.createEl("p", { text: "On any device with a browser, open this page and enter the code:" });
    box.createEl("p", { text: dc.verificationUrl });
    box.createDiv({ cls: "dvs-user-code", text: dc.userCode });
    const row = box.createDiv();
    const open = row.createEl("button", { text: "Open Google page" });
    open.onclick = () => window.open(dc.verificationUrl);
    const cancel = row.createEl("button", { text: "Cancel" });
    cancel.onclick = () => {
      if (this.flow) this.flow.cancelled = true;
      box.empty();
      box.hide();
    };
  }

  private async signIn() {
    const d = this.plugin.data.draft;
    if (!d.clientId || !d.clientSecret || !d.folderName) {
      this.setStatus("Fill in the client ID, client secret and folder name first.");
      return;
    }
    if (this.flow) this.flow.cancelled = true;
    const flow: FlowControl = { cancelled: false };
    this.flow = flow;
    try {
      this.setStatus("Asking Google for a sign-in code…");
      const dc = await startDeviceFlow(d.clientId);
      this.showCode(dc);
      this.setStatus("Waiting for you to approve in Google…");
      const refreshToken = await pollForToken(d.clientId, d.clientSecret, dc, flow);

      this.setStatus("Signed in. Preparing your Drive folder…");
      const cred: Credentials = {
        clientId: d.clientId,
        clientSecret: d.clientSecret,
        refreshToken,
        folderId: "",
        folderName: d.folderName,
      };
      const drive = new DriveClient(new DriveAuth(cred));
      const folder = (await drive.findFolder(d.folderName)) ?? (await drive.createFolder(d.folderName));
      cred.folderId = folder.id;
      await this.plugin.connect(cred);
      this.display();
      this.setStatus(`Connected. Drive folder "${folder.name}" is ready.`);
    } catch (e) {
      this.setStatus(errMsg(e));
    }
  }

  private async connectWithCode() {
    const code = this.connectCodeEl ? this.connectCodeEl.value : "";
    const pass = this.connectPassEl ? this.connectPassEl.value : "";
    try {
      this.setStatus(`Unlocking the code… this can take up to a minute on a phone. ${describeCode(code)}`);
      const cred = await readConnectionCode(code, pass);
      this.setStatus("Checking access to your Drive folder…");
      const drive = new DriveClient(new DriveAuth(cred));
      const folder = await drive.getFolder(cred.folderId);
      if (folder.trashed) throw new Error("That Drive folder is in the trash. Restore it in Google Drive and try again.");
      await this.plugin.connect(cred);
      this.display();
      this.setStatus(`Connected. Found Drive folder "${folder.name}".`);
    } catch (e) {
      this.setStatus(`${errMsg(e)}\n${describeCode(code)}`);
    }
  }

  // ---------- Connected ----------
  private renderConnected(el: HTMLElement) {
    const c = this.plugin.data.credentials as Credentials;

    new Setting(el)
      .setName("Connected")
      .setDesc(`Drive folder: ${c.folderName}`);

    new Setting(el)
      .setName("Test connection")
      .setDesc("Checks that Google Drive and the folder are reachable.")
      .addButton((b) => b.setButtonText("Test").onClick(() => this.testConnection()));

    new Setting(el).setName("Automatic sync").setHeading();
    new Setting(el)
      .setName("Sync automatically while Obsidian is open")
      .setDesc("Uploads your edits and applies other devices' changes in the background. Everything is stored inside your Drive vault folder only.")
      .addToggle((t) => {
        this.autoToggle = t;
        t.setValue(this.plugin.data.autoSync).onChange((v) => this.toggleAuto(v));
      });
    new Setting(el)
      .setName("This device's name")
      .setDesc("Appears in the names of conflict copies, for example: note (conflict Laptop 2026-10-11 0818).md")
      .addText((t) =>
        t.setValue(this.plugin.data.deviceName).onChange(async (v) => {
          this.plugin.data.deviceName = v.trim() || this.plugin.data.deviceName;
          this.plugin.engine = null; // pick up the new name
          await this.plugin.savePluginData();
        })
      );
    this.syncStatusEl = el.createDiv({ cls: "dvs-status" });
    this.enableEl = el.createDiv();
    this.plugin.onStatusChange = () => this.refreshSyncStatus();
    this.refreshSyncStatus();
    new Setting(el)
      .setName("Diagnostics")
      .setDesc("The log contains file names and results only, never note contents.")
      .addButton((b) => b.setButtonText("Sync now").onClick(() => void this.plugin.syncNow()))
      .addButton((b) =>
        b.setButtonText("Copy log").onClick(async () => {
          const log = this.plugin.engine ? this.plugin.engine.getLog() : "";
          try {
            await navigator.clipboard.writeText(log || "(empty)");
            this.setStatus("Log copied.");
          } catch {
            this.setStatus(log || "The log is empty.");
          }
        })
      );

    new Setting(el).setName("Manual tools (not needed once automatic sync is on)").setHeading();
    el.createEl("p", {
      cls: "dvs-status",
      text: "Scan first, read the summary, then start. Nothing on this device or on Drive is ever deleted or overwritten.",
    });
    new Setting(el)
      .setName("Back up this vault to Drive")
      .setDesc("Uploads files that are not on Drive yet. Use this on your main device first.")
      .addButton((b) => b.setButtonText("Scan").onClick(() => this.scanBackup()));
    new Setting(el)
      .setName("Download from Drive into this vault")
      .setDesc("Downloads files that are not here yet. Use this on a new device. Start with an empty vault.")
      .addButton((b) => b.setButtonText("Scan").onClick(() => this.scanDownload()));
    this.reportEl = el.createDiv({ cls: "dvs-report" });
    this.actionEl = el.createDiv();

    new Setting(el).setName("Add another device").setHeading();
    const mk = new Setting(el)
      .setName("Passphrase for the code")
      .setDesc("At least 12 characters. Use 4 or more random words. You type it on each new device.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.inputEl.autocomplete = "off";
        this.createPassEl = t.inputEl;
      });
    this.addShowToggle(mk, this.createPassEl as unknown as HTMLInputElement);
    new Setting(el).addButton((b) =>
      b.setButtonText("Create connection code").setCta().onClick(() => this.makeCode())
    );
    this.inlineEl = el.createDiv({ cls: "dvs-status" });
    this.codeBox = el.createEl("textarea", { cls: "dvs-code", attr: { readonly: "true", rows: "6" } });
    this.codeBox.hide();
    new Setting(el).addButton((b) =>
      b.setButtonText("Copy code").onClick(async () => {
        if (!this.codeBox || !this.codeBox.value) {
          this.setStatus("Create a connection code first.");
          return;
        }
        try {
          await navigator.clipboard.writeText(this.codeBox.value);
          this.setStatus("Code copied.");
        } catch {
          this.setStatus("Could not copy automatically. Select the code and copy it by hand.");
        }
      })
    );

    new Setting(el).setName("Disconnect").setHeading();
    new Setting(el)
      .setName("Disconnect this device")
      .setDesc("Removes the saved Google key from this device. Your Drive files are not deleted.")
      .addButton((b) =>
        b.setButtonText("Disconnect").setWarning().onClick(async () => {
          await this.plugin.disconnect();
          this.display();
        })
      );
  }

  private refreshSyncStatus() {
    const el = this.syncStatusEl;
    if (!el || !el.isConnected) return;
    if (!this.plugin.data.autoSync) {
      el.setText("Automatic sync is off.");
      return;
    }
    const st = this.plugin.status;
    const lines = [st.message];
    if (st.lastSuccess) lines.push(`Last successful check: ${new Date(st.lastSuccess).toLocaleTimeString()}`);
    if (st.last) {
      const l = st.last;
      lines.push(`Last run: ${l.up} uploaded, ${l.down} downloaded, ${l.del} deleted, ${l.conflicts} conflict(s), ${l.skipped} skipped, ${l.errors} error(s)`);
    }
    el.setText(lines.join("\n"));
  }

  private async toggleAuto(on: boolean) {
    this.enableEl.empty();
    this.reportEl.setText("");
    if (!on) {
      await this.plugin.setAutoSync(false);
      this.refreshSyncStatus();
      return;
    }
    try {
      this.setStatus("Checking Drive and this vault…");
      const engine = await this.plugin.ensureEngine();
      if (!engine) throw new Error("This device is not connected.");
      if (engine.isInitialized()) {
        await this.plugin.setAutoSync(true);
        this.setStatus("Automatic sync is on.");
        this.refreshSyncStatus();
        return;
      }
      const { text } = await engine.preview();
      this.reportEl.setText(text);
      this.setStatus("Read the preview, then confirm to start automatic sync.");
      new Setting(this.enableEl)
        .setName("Start automatic sync with this plan?")
        .addButton((b) =>
          b.setButtonText("Yes, start").setCta().onClick(async () => {
            await engine.markInitialized();
            await this.plugin.setAutoSync(true);
            this.enableEl.empty();
            this.reportEl.setText("");
            this.setStatus("Automatic sync is on.");
            this.refreshSyncStatus();
          })
        )
        .addButton((b) =>
          b.setButtonText("Cancel").onClick(() => {
            this.autoToggle?.setValue(false);
            this.enableEl.empty();
            this.reportEl.setText("");
            this.setStatus("Cancelled. Automatic sync is off.");
          })
        );
    } catch (e) {
      this.autoToggle?.setValue(false);
      this.setStatus(errMsg(e));
    }
  }

  // ---------- Backup and download ----------
  private resetReport() {
    this.reportEl.setText("");
    this.actionEl.empty();
  }

  private showStart(label: string, run: () => Promise<void>) {
    this.actionEl.empty();
    new Setting(this.actionEl).addButton((b) =>
      b.setButtonText(label).setCta().onClick(async () => {
        if (this.busy) return;
        this.busy = true;
        this.actionEl.empty();
        try {
          await run();
        } catch (e) {
          this.setStatus(errMsg(e));
        } finally {
          this.busy = false;
        }
      })
    );
  }

  private async scanBackup() {
    const c = this.plugin.data.credentials;
    if (!c || this.busy) return;
    if (this.plugin.data.autoSync) return this.setStatus("Turn off automatic sync first if you want to use the manual tools.");
    this.busy = true;
    this.resetReport();
    try {
      const drive = new DriveClient(new DriveAuth(c));
      this.setStatus("Reading Drive…");
      const { entries, problems } = await drive.listTree(c.folderId);
      const local = await scanLocal(this.app, (m) => this.setStatus(m));
      const plan = planBackup(local.files, local.folders, entries, MAX_SIMPLE_UPLOAD);
      this.reportEl.setText(describeBackup(plan, problems));
      if (plan.upload.length + plan.foldersToCreate.length === 0) {
        this.setStatus("Scan finished. Nothing needs to be uploaded.");
      } else {
        this.setStatus("Scan finished. Read the summary, then start. Start soon, because the scan is a snapshot.");
        this.showStart("Start backup", () => this.runBackup(drive, c.folderId, plan, entries));
      }
    } catch (e) {
      this.setStatus(errMsg(e));
    } finally {
      this.busy = false;
    }
  }

  private async runBackup(drive: DriveClient, rootId: string, plan: BackupPlan, remote: Map<string, RemoteEntry>) {
    const res = await executeBackup(this.app, drive, rootId, plan, remote, (m) => this.setStatus(m));
    this.reportEl.setText(describeResult("BACKUP RESULT", res.done, res.verified, res.failed, res.notes));
    this.setStatus(res.failed.length ? "Backup finished with problems. See the result below." : "Backup finished and verified.");
  }

  private async scanDownload() {
    const c = this.plugin.data.credentials;
    if (!c || this.busy) return;
    if (this.plugin.data.autoSync) return this.setStatus("Turn off automatic sync first if you want to use the manual tools.");
    this.busy = true;
    this.resetReport();
    try {
      const drive = new DriveClient(new DriveAuth(c));
      this.setStatus("Reading Drive…");
      const { entries, problems } = await drive.listTree(c.folderId);
      const local = await scanLocal(this.app, (m) => this.setStatus(m));
      const localFiles = new Map<string, LocalFile>(local.files.map((f) => [f.path, f]));
      const plan = planDownload(localFiles, new Set(local.folders), entries);
      this.reportEl.setText(describeDownload(plan, problems));
      if (plan.download.length + plan.foldersToCreate.length === 0) {
        this.setStatus("Scan finished. Nothing needs to be downloaded.");
      } else {
        this.setStatus("Scan finished. Read the summary, then start.");
        this.showStart("Start download", () => this.runDownload(drive, plan));
      }
    } catch (e) {
      this.setStatus(errMsg(e));
    } finally {
      this.busy = false;
    }
  }

  private async runDownload(drive: DriveClient, plan: DownloadPlan) {
    const res = await executeDownload(this.app, drive, plan, (m) => this.setStatus(m));
    this.reportEl.setText(describeResult("DOWNLOAD RESULT", res.done, res.verified, res.failed, res.notes));
    this.setStatus(res.failed.length ? "Download finished with problems. See the result below." : "Download finished and verified.");
  }

  private async testConnection() {
    const c = this.plugin.data.credentials;
    if (!c) return;
    try {
      this.setStatus("Testing…");
      const drive = new DriveClient(new DriveAuth(c));
      const f = await drive.getFolder(c.folderId);
      const n = await drive.countChildren(c.folderId);
      this.setStatus(`OK: folder "${f.name}" is reachable and contains ${n} item(s).`);
    } catch (e) {
      this.setStatus(errMsg(e));
    }
  }

  private async makeCode() {
    const c = this.plugin.data.credentials;
    if (!c) return;
    const pass = this.createPassEl ? this.createPassEl.value : "";
    if (pass.length < 12) {
      this.setStatus("The passphrase must be at least 12 characters.");
      return;
    }
    try {
      this.setStatus("Creating the code… this takes a few seconds.");
      const code = await createConnectionCode(c, pass);
      // Self-test: prove this code opens with exactly the passphrase typed in the box.
      await readConnectionCode(code, pass);
      if (this.codeBox) {
        this.codeBox.value = code;
        this.codeBox.show();
      }
      this.setStatus(`Code created and self-test passed (it opens with the passphrase you typed, ${pass.length} characters). ${describeCode(code)} Copy it and keep it somewhere safe.`);
    } catch (e) {
      this.setStatus(errMsg(e));
    }
  }
}
