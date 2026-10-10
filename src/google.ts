import { requestUrl, RequestUrlResponse } from "obsidian";
import { Credentials } from "./types";

const DEVICE_URL = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_URL = "https://www.googleapis.com/drive/v3";
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

export class DriveClient {
  constructor(private auth: DriveAuth) {}

  private async call(method: string, path: string, query?: Record<string, string>, body?: unknown): Promise<any> {
    const token = await this.auth.getAccessToken();
    const url = DRIVE_URL + path + (query ? "?" + new URLSearchParams(query).toString() : "");
    const res = await requestUrl({
      url,
      method,
      headers: { Authorization: `Bearer ${token}` },
      contentType: body ? "application/json" : undefined,
      body: body ? JSON.stringify(body) : undefined,
      throw: false,
    });
    if (res.status >= 400) {
      const j = jsonOf(res);
      throw new Error(`Google Drive error ${res.status}: ${j.error?.message ?? res.status}`);
    }
    return jsonOf(res);
  }

  async findFolder(name: string): Promise<DriveFolder | null> {
    const j = await this.call("GET", "/files", {
      q: `name = '${escapeQ(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id,name)",
      pageSize: "10",
    });
    return (j.files && j.files[0]) || null;
  }

  async createFolder(name: string): Promise<DriveFolder> {
    return this.call("POST", "/files", { fields: "id,name" }, {
      name,
      mimeType: "application/vnd.google-apps.folder",
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
}
