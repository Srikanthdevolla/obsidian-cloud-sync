export interface Credentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  folderId: string;
  folderName: string;
}

export interface Draft {
  clientId: string;
  clientSecret: string;
  folderName: string;
}

export interface PluginData {
  credentials: Credentials | null;
  draft: Draft;
}

export function defaultData(): PluginData {
  return {
    credentials: null,
    draft: { clientId: "", clientSecret: "", folderName: "" },
  };
}

export interface RemoteEntry {
  id: string;
  path: string;
  name: string;
  isFolder: boolean;
  native: boolean; // Google Docs/Sheets etc. (cannot be downloaded as a normal file)
  size: number;
  sha256: string | null; // set by this plugin at upload time
}

export interface RunResult {
  done: number;
  failed: { path: string; error: string }[];
  verified: number;
  notes: string[];
}
