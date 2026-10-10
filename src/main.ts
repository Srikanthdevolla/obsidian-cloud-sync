import { Plugin } from "obsidian";
import { Credentials, PluginData, defaultData } from "./types";
import { DriveSyncSettingTab } from "./settings";

export default class DriveVaultSyncPlugin extends Plugin {
  data: PluginData = defaultData();

  async onload() {
    const saved = (await this.loadData()) as Partial<PluginData> | null;
    const base = defaultData();
    this.data = {
      credentials: saved?.credentials ?? null,
      draft: { ...base.draft, ...(saved?.draft ?? {}) },
    };
    this.addSettingTab(new DriveSyncSettingTab(this.app, this));
  }

  async savePluginData() {
    await this.saveData(this.data);
  }

  async connect(cred: Credentials) {
    this.data.credentials = cred;
    await this.savePluginData();
  }

  async disconnect() {
    this.data.credentials = null;
    await this.savePluginData();
  }
}
