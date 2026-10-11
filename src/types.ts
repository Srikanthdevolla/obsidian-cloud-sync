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
  autoSync: boolean;
  deviceName: string;
}

export function defaultData(): PluginData {
  return {
    credentials: null,
    draft: { clientId: "", clientSecret: "", folderName: "" },
    autoSync: false,
    deviceName: "",
  };
}

// What both sides looked like the last time they were identical.
export interface BaseFile { id: string; hash: string; mtime: number; size: number }

export interface SyncState {
  version: 1;
  folderId: string; // the Drive root folder this state belongs to
  initialized: boolean;
  files: Record<string, BaseFile>;
  folders: Record<string, string>; // path -> Drive folder id
  pageToken: string | null; // Drive change-feed position
  lastFullAt: number;
}

export function blankState(folderId: string): SyncState {
  return { version: 1, folderId, initialized: false, files: {}, folders: {}, pageToken: null, lastFullAt: 0 };
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
