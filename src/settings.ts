import { App, PluginSettingTab, Setting } from "obsidian";
import type DriveVaultSyncPlugin from "./main";
import { Credentials } from "./types";
import {
  DeviceCode, DriveAuth, DriveClient, FlowControl,
  errMsg, pollForToken, startDeviceFlow,
} from "./google";
import { createConnectionCode, readConnectionCode } from "./crypto";

export class DriveSyncSettingTab extends PluginSettingTab {
  plugin: DriveVaultSyncPlugin;
  private statusEl!: HTMLElement;
  private deviceEl!: HTMLElement;
  private codeBox: HTMLTextAreaElement | null = null;
  private flow: FlowControl | null = null;
  private passphrase = "";
  private connectCode = "";

  constructor(app: App, plugin: DriveVaultSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  hide(): void {
    if (this.flow) this.flow.cancelled = true;
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
      t.setPlaceholder("DVS1.…").onChange((v) => (this.connectCode = v));
      t.inputEl.rows = 4;
    });
    new Setting(el).setName("Passphrase").addText((t) => {
      t.inputEl.type = "password";
      t.onChange((v) => (this.passphrase = v));
    });
    new Setting(el).addButton((b) =>
      b.setButtonText("Connect this device").setCta().onClick(() => this.connectWithCode())
    );
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
    try {
      this.setStatus("Unlocking the code… this takes a few seconds.");
      const cred = await readConnectionCode(this.connectCode, this.passphrase);
      this.setStatus("Checking access to your Drive folder…");
      const drive = new DriveClient(new DriveAuth(cred));
      const folder = await drive.getFolder(cred.folderId);
      if (folder.trashed) throw new Error("That Drive folder is in the trash. Restore it in Google Drive and try again.");
      await this.plugin.connect(cred);
      this.connectCode = "";
      this.passphrase = "";
      this.display();
      this.setStatus(`Connected. Found Drive folder "${folder.name}".`);
    } catch (e) {
      this.setStatus(errMsg(e));
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

    new Setting(el).setName("Add another device").setHeading();
    new Setting(el)
      .setName("Passphrase for the code")
      .setDesc("At least 12 characters. Use 4 or more random words. You type it on each new device.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.onChange((v) => (this.passphrase = v));
      });
    new Setting(el).addButton((b) =>
      b.setButtonText("Create connection code").setCta().onClick(() => this.makeCode())
    );
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
    if (this.passphrase.length < 12) {
      this.setStatus("The passphrase must be at least 12 characters.");
      return;
    }
    try {
      this.setStatus("Creating the code… this takes a few seconds.");
      const code = await createConnectionCode(c, this.passphrase);
      if (this.codeBox) {
        this.codeBox.value = code;
        this.codeBox.show();
      }
      this.setStatus("Code created. Copy it and keep it somewhere safe, like a password manager.");
    } catch (e) {
      this.setStatus(errMsg(e));
    }
  }
}
