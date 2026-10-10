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
