import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { Credentials, RemoteEntry } from "./types";
import { isSafeName, sleep } from "./util";

const DEVICE_URL = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_URL = "https://www.googleapis.com/drive/v3";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const FORM = "application/x-www-form-urlencoded";

export interface FlowControl { cancelled: boolean }

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function jsonOf(res: RequestUrlResponse): any {
  try {
    return res.json ?? {};
  } catch {
    return {};
  }
}

function form(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

export async function startDeviceFlow(clientId: string): Promise<DeviceCode> {
  const res = await requestUrl({
    url: DEVICE_URL,
    method: "POST",
    contentType: FORM,
    body: form({ client_id: clientId, scope: SCOPE }),
    throw: false,
  });
  const j = jsonOf(res);
  if (res.status !== 200 || !j.device_code) {
    throw new Error(`Google refused the sign-in request (${res.status}): ${j.error_description ?? j.error ?? "unknown error"}`);
  }
  return {
    deviceCode: j.device_code,
    userCode: j.user_code,
    verificationUrl: j.verification_url,
    expiresIn: j.expires_in,
    interval: j.interval ?? 5,
  };
}

export async function pollForToken(
  clientId: string,
  clientSecret: string,
  dc: DeviceCode,
  flow: FlowControl
): Promise<string> {
  let interval = dc.interval;
  const deadline = Date.now() + dc.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    if (flow.cancelled) throw new Error("Sign-in cancelled.");
    const res = await requestUrl({
      url: TOKEN_URL,
      method: "POST",
      contentType: FORM,
      body: form({
        client_id: clientId,
        client_secret: clientSecret,
        device_code: dc.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      throw: false,
    });
    const j = jsonOf(res);
    if (res.status === 200 && j.refresh_token) return j.refresh_token as string;
    if (res.status === 200) throw new Error("Google did not return a long-lived key. Try signing in again.");
    switch (j.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5;
        continue;
      case "access_denied":
        throw new Error("You declined access in Google.");
      case "expired_token":
        throw new Error("The sign-in code expired. Start again.");
      default:
        throw new Error(`Google sign-in failed: ${j.error_description ?? j.error ?? res.status}`);
    }
  }
  throw new Error("Sign-in timed out. Start again.");
}

export class DriveAuth {
  private token = "";
  private expiresAt = 0;
  constructor(private cred: Credentials) {}

  async getAccessToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - 60000) return this.token;
    const res = await requestUrl({
      url: TOKEN_URL,
      method: "POST",
      contentType: FORM,
      body: form({
        client_id: this.cred.clientId,
        client_secret: this.cred.clientSecret,
        refresh_token: this.cred.refreshToken,
        grant_type: "refresh_token",
      }),
      throw: false,
    });
    const j = jsonOf(res);
    if (res.status !== 200 || !j.access_token) {
      if (j.error === "invalid_grant") {
        throw new Error("Your Google sign-in expired or was revoked. In Google's Testing mode this happens every 7 days. Disconnect and sign in again.");
      }
      throw new Error(`Could not refresh Google access (${res.status}): ${j.error_description ?? j.error ?? "unknown"}`);
    }
    this.token = j.access_token;
    this.expiresAt = Date.now() + (j.expires_in ?? 3600) * 1000;
    return this.token;
  }
}

function escapeQ(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export interface DriveFolder { id: string; name: string; trashed?: boolean }

interface RawFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  appProperties?: Record<string, string>;
}

export class DriveClient {
  constructor(private auth: DriveAuth) {}

  // One place for authorization and retries (rate limits and temporary server errors).
  private async request(p: RequestUrlParam): Promise<RequestUrlResponse> {
    const delays = [1000, 2000, 4000, 8000];
    for (let attempt = 0; ; attempt++) {
      const token = await this.auth.getAccessToken();
      const res = await requestUrl({
        ...p,
        headers: { ...(p.headers ?? {}), Authorization: `Bearer ${token}` },
        throw: false,
      });
      const rateLimited = res.status === 403 && /rate ?limit/i.test(res.text ?? "");
      if ((res.status === 429 || res.status >= 500 || rateLimited) && attempt < delays.length) {
        await sleep(delays[attempt]);
        continue;
      }
      return res;
    }
  }

  private async call(method: string, path: string, query?: Record<string, string>, body?: unknown): Promise<any> {
    const url = DRIVE_URL + path + (query ? "?" + new URLSearchParams(query).toString() : "");
    const res = await this.request({
      url,
      method,
      contentType: body ? "application/json" : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status >= 400) {
      const j = jsonOf(res);
      throw new Error(`Google Drive error ${res.status}: ${j.error?.message ?? res.status}`);
    }
    return jsonOf(res);
  }

  async findFolder(name: string): Promise<DriveFolder | null> {
    const j = await this.call("GET", "/files", {
      q: `name = '${escapeQ(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
      fields: "files(id,name)",
      pageSize: "10",
    });
    return (j.files && j.files[0]) || null;
  }

  async createFolder(name: string, parentId?: string): Promise<DriveFolder> {
    return this.call("POST", "/files", { fields: "id,name" }, {
      name,
      mimeType: FOLDER_MIME,
      ...(parentId ? { parents: [parentId] } : {}),
    });
  }

  async getFolder(id: string): Promise<DriveFolder> {
    return this.call("GET", "/files/" + encodeURIComponent(id), { fields: "id,name,trashed" });
  }

  async countChildren(folderId: string): Promise<number> {
    const j = await this.call("GET", "/files", {
      q: `'${folderId}' in parents and trashed = false`,
      fields: "files(id)",
      pageSize: "100",
    });
    return (j.files ?? []).length;
  }

  private async listChildren(folderId: string): Promise<RawFile[]> {
    const out: RawFile[] = [];
    let pageToken = "";
    do {
      const q: Record<string, string> = {
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken,files(id,name,mimeType,size,appProperties)",
        pageSize: "1000",
      };
      if (pageToken) q.pageToken = pageToken;
      const j = await this.call("GET", "/files", q);
      out.push(...((j.files ?? []) as RawFile[]));
      pageToken = j.nextPageToken ?? "";
    } while (pageToken);
    return out;
  }

  // Lists everything under the vault folder, keyed by path (e.g. "notes/a.md").
  async listTree(rootId: string): Promise<{ entries: Map<string, RemoteEntry>; problems: string[] }> {
    const entries = new Map<string, RemoteEntry>();
    const problems: string[] = [];
    const queue: { id: string; path: string }[] = [{ id: rootId, path: "" }];
    while (queue.length) {
      const cur = queue.shift() as { id: string; path: string };
      const children = await this.listChildren(cur.id);
      const seen = new Set<string>();
      for (const f of children) {
        const path = cur.path ? `${cur.path}/${f.name}` : f.name;
        if (!isSafeName(f.name)) {
          problems.push(`Skipped a Drive item with an unsafe name: ${path}`);
          continue;
        }
        if (seen.has(f.name)) {
          problems.push(`Duplicate name on Drive (second copy ignored): ${path}`);
          continue;
        }
        seen.add(f.name);
        const isFolder = f.mimeType === FOLDER_MIME;
        entries.set(path, {
          id: f.id,
          path,
          name: f.name,
          isFolder,
          native: !isFolder && f.mimeType.startsWith("application/vnd.google-apps."),
          size: f.size ? parseInt(f.size, 10) : 0,
          sha256: f.appProperties?.sha256 ?? null,
        });
        if (isFolder) queue.push({ id: f.id, path });
      }
    }
    return { entries, problems };
  }

  async uploadFile(parentId: string, name: string, data: ArrayBuffer, sha256: string): Promise<{ id: string }> {
    const boundary = "dvs" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const enc = new TextEncoder();
    const meta = JSON.stringify({ name, parents: [parentId], appProperties: { sha256 } });
    const head = enc.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
      `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const tail = enc.encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(head.length + data.byteLength + tail.length);
    body.set(head, 0);
    body.set(new Uint8Array(data), head.length);
    body.set(tail, head.length + data.byteLength);
    const res = await this.request({
      url: `${UPLOAD_URL}?uploadType=multipart&fields=id`,
      method: "POST",
      contentType: `multipart/related; boundary=${boundary}`,
      body: body.buffer as ArrayBuffer,
    });
    if (res.status >= 400) {
      const j = jsonOf(res);
      throw new Error(`Upload failed (${res.status}): ${j.error?.message ?? "unknown"}`);
    }
    return jsonOf(res) as { id: string };
  }

  async download(fileId: string): Promise<ArrayBuffer> {
    const res = await this.request({
      url: `${DRIVE_URL}/files/${encodeURIComponent(fileId)}?alt=media`,
      method: "GET",
    });
    if (res.status >= 400) {
      const j = jsonOf(res);
      throw new Error(`Download failed (${res.status}): ${j.error?.message ?? "unknown"}`);
    }
    return res.arrayBuffer;
  }
}
