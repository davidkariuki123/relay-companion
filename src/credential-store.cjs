"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const localStore = require("./local-credential-store.cjs");

const SERVICE = "work.relay.companion";
const ACCOUNT = "device-token";
const MACOS_PROMPT_MAX_BYTES = 120;

// `security add-generic-password ... -w` only reads from a terminal. Giving it
// a normal stdin pipe exits successfully but stores an empty password. Expect
// supplies the terminal while the credential itself still travels only over
// stdin; it never appears in argv or the environment.
const MACOS_WRITE_SCRIPT = String.raw`set timeout 20
fconfigure stdin -translation binary -encoding binary
set secret [read stdin]
spawn -noecho /usr/bin/security add-generic-password -U -s $env(RELAY_CREDENTIAL_SERVICE) -a $env(RELAY_CREDENTIAL_ACCOUNT) -w
expect {
  -re {(?i)password.*:} { send -- "$secret\r"; exp_continue }
  eof {}
  timeout { exit 124 }
}
set outcome [wait]
exit [lindex $outcome 3]`;

function resultOf(command, args, { env = process.env, run = spawnSync, input, ...spawnOptions } = {}) {
  const result = run(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
    env,
    ...(input === undefined ? {} : { input }),
    ...spawnOptions,
  });
  const outcome = {
    ok: !result?.error && result?.status === 0,
    value: String(result?.stdout || "").replace(/[\r\n]+$/, ""),
    detail: result?.error?.message || String(result?.stderr || "").trim(),
  };
  Object.defineProperty(outcome, "status", { value: result?.status, enumerable: false });
  return outcome;
}

function classifiedFailure(result, { platform = process.platform } = {}) {
  const evidence = `${result?.detail || ""}\n${result?.value || ""}`;
  const missing = /could not be found|cannot find|-25300|element not found/i.test(evidence)
    || (platform === "darwin" && result?.status === 44)
    || (platform === "win32" && result?.status === 3);
  if (missing) {
    return { ok: false, value: "", detail: "native credential was not found", code: "credential_not_found" };
  }
  const unavailable = /user name or passphrase|authentication failed|authfailed|interaction.*not allowed|-25293|-25308|keychain.*locked/i.test(evidence);
  if (unavailable || (platform === "darwin" && [36, 51].includes(result?.status))) {
    return { ok: false, value: "", detail: "native credential store is locked or unavailable", code: "credential_unavailable" };
  }
  if (result?.status === 124 || /timed?\s*out/i.test(evidence)) {
    return { ok: false, value: "", detail: "native credential store operation timed out", code: "credential_timeout" };
  }
  return {
    ok: false,
    value: "",
    detail: result?.detail || "native credential store operation failed",
    code: "credential_store_error",
  };
}

const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$type=@'
using System; using System.Runtime.InteropServices; using System.Text;
public static class RelayCredential {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct CREDENTIAL {
  public UInt32 Flags,Type; public string TargetName,Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist,AttributeCount; public IntPtr Attributes;
  public string TargetAlias,UserName; }
 [DllImport("advapi32.dll",EntryPoint="CredWriteW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CredWrite(ref CREDENTIAL c,UInt32 f);
 [DllImport("advapi32.dll",EntryPoint="CredReadW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CredRead(string t,UInt32 y,UInt32 f,out IntPtr c);
 [DllImport("advapi32.dll",EntryPoint="CredDeleteW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CredDelete(string t,UInt32 y,UInt32 f);
 [DllImport("advapi32.dll")] static extern void CredFree(IntPtr c);
 public static void Write(string t,string u,string s) { byte[] b=Encoding.Unicode.GetBytes(s); IntPtr p=Marshal.AllocCoTaskMem(b.Length);
  try { Marshal.Copy(b,0,p,b.Length); var c=new CREDENTIAL{Type=1,TargetName=t,CredentialBlobSize=(UInt32)b.Length,CredentialBlob=p,Persist=2,UserName=u};
   if(!CredWrite(ref c,0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
  finally { for(int i=0;i<b.Length;i++) Marshal.WriteByte(p,i,0); Marshal.FreeCoTaskMem(p); } }
 public static string Read(string t) { IntPtr p; if(!CredRead(t,1,0,out p)) { int e=Marshal.GetLastWin32Error(); if(e==1168) return null; throw new System.ComponentModel.Win32Exception(e); }
  try { var c=(CREDENTIAL)Marshal.PtrToStructure(p,typeof(CREDENTIAL));
  return c.CredentialBlob==IntPtr.Zero?"":Marshal.PtrToStringUni(c.CredentialBlob,(int)c.CredentialBlobSize/2); } finally { CredFree(p); } }
 public static void Delete(string t) { if(!CredDelete(t,1,0)&&Marshal.GetLastWin32Error()!=1168) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
}
'@
Add-Type -TypeDefinition $type
switch($env:RELAY_CREDENTIAL_ACTION) {
 'write' { $secret=[Console]::In.ReadToEnd(); [RelayCredential]::Write($env:RELAY_CREDENTIAL_TARGET,$env:RELAY_CREDENTIAL_ACCOUNT,$secret) }
 'read' { $v=[RelayCredential]::Read($env:RELAY_CREDENTIAL_TARGET); if($null -eq $v){exit 3}; [Console]::Out.Write($v) }
 'delete' { [RelayCredential]::Delete($env:RELAY_CREDENTIAL_TARGET) }
 default { throw 'Unsupported credential action' }
}`;

function operation(
  action,
  secret = "",
  { platform = process.platform, service = SERVICE, account = ACCOUNT, ...options } = {},
) {
  const credentialService = String(service || "").trim();
  const credentialAccount = String(account || "").trim();
  if (!credentialService || !credentialAccount) return { ok: false, value: "", detail: "invalid credential identity" };
  if (platform === "darwin") {
    if (action === "write") {
      if (Buffer.byteLength(secret, "utf8") > MACOS_PROMPT_MAX_BYTES) {
        return { ok: false, value: "", detail: "credential exceeds the macOS secure prompt limit", code: "credential_too_large" };
      }
      const writeResult = resultOf("/usr/bin/expect", ["-c", MACOS_WRITE_SCRIPT], {
        ...options,
        env: {
          ...(options.env || process.env),
          RELAY_CREDENTIAL_SERVICE: credentialService,
          RELAY_CREDENTIAL_ACCOUNT: credentialAccount,
        },
        input: secret,
      });
      if (!writeResult.ok) return classifiedFailure(writeResult, { platform });
      const verifyResult = resultOf(
        "/usr/bin/security",
        ["find-generic-password", "-s", credentialService, "-a", credentialAccount, "-w"],
        options,
      );
      if (verifyResult.ok && verifyResult.value === secret) return { ok: true, value: "", detail: "" };
      resultOf(
        "/usr/bin/security",
        ["delete-generic-password", "-s", credentialService, "-a", credentialAccount],
        options,
      );
      if (!verifyResult.ok) return classifiedFailure(verifyResult, { platform });
      return { ok: false, value: "", detail: "native credential verification failed", code: "credential_verification_failed" };
    }
    let args;
    if (action === "read") args = ["find-generic-password", "-s", credentialService, "-a", credentialAccount, "-w"];
    else args = ["delete-generic-password", "-s", credentialService, "-a", credentialAccount];
    const result = resultOf("/usr/bin/security", args, options);
    const classified = result.ok ? null : classifiedFailure(result, { platform });
    if (action === "delete" && classified?.code === "credential_not_found") return { ok: true, value: "" };
    return result.ok ? result : classified;
  }
  if (platform === "win32") {
    // TargetName, not UserName, is the Credential Manager uniqueness key. Keep
    // the historical device-token target unchanged while namespacing any
    // additional Relay capabilities under the same product identity.
    const target = credentialService === SERVICE && credentialAccount === ACCOUNT
      ? SERVICE
      : `${credentialService}/${credentialAccount}`;
    const result = resultOf("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT], {
      ...options,
      env: { ...(options.env || process.env), RELAY_CREDENTIAL_ACTION: action, RELAY_CREDENTIAL_TARGET: target,
        RELAY_CREDENTIAL_ACCOUNT: credentialAccount },
      ...(action === "write" ? { input: secret } : {}),
    });
    const classified = result.ok ? null : classifiedFailure(result, { platform });
    if (action === "delete" && classified?.code === "credential_not_found") return { ok: true, value: "" };
    return result.ok ? result : classified;
  }
  return { ok: false, value: "", detail: "native credential store unsupported", code: "credential_store_unsupported" };
}

function legacyMacAvailable({ run = spawnSync, env = process.env, homeDir = os.homedir(), ...options } = {}) {
  const keychain = path.join(homeDir, "Library", "Keychains", "login.keychain-db");
  const result = resultOf("/usr/bin/security", ["show-keychain-info", keychain], { run, env, ...options });
  return result.ok ? { ok: true, value: "", detail: "" } : classifiedFailure(result, { platform: "darwin" });
}

function readLegacyMacCredential(options = {}) {
  const available = legacyMacAvailable(options);
  if (!available.ok) return available;
  return operation("read", "", { ...options, platform: "darwin" });
}

function platformOf(options) { return options?.platform || process.platform; }
function credentialOptions(options = {}) {
  return { ...options, service: options.service || SERVICE, account: options.account || ACCOUNT };
}

function writeDeviceToken(token, options) {
  return writeCredential(token, options);
}
function readDeviceToken(options = {}) {
  return readCredential({ ...options, allowLegacyMigration: options.allowLegacyMigration === true });
}
function deleteDeviceToken(options) { return deleteCredential(options); }

function writeCredential(secret, options) {
  if (!String(secret || "")) return { ok: false, value: "", detail: "empty credential", code: "credential_store_error" };
  if (platformOf(options) === "darwin") return localStore.writeCredential(String(secret), credentialOptions(options));
  return operation("write", String(secret), options);
}
function readCredential(options = {}) {
  if (platformOf(options) !== "darwin") return operation("read", "", options);
  const target = credentialOptions(options);
  const local = localStore.readCredential(target);
  if (local.ok || local.code !== "credential_not_found") return local;
  if (options.allowLegacyMigration !== true) return local;
  // One silent compatibility read migrates pre-0.1.356 credentials. The
  // show-keychain-info preflight returns before `find-generic-password` when
  // a locked or poisoned login Keychain would otherwise present UI.
  const legacy = readLegacyMacCredential(target);
  if (!legacy.ok) return legacy.code === "credential_not_found" ? local : legacy;
  const migrated = localStore.writeCredential(legacy.value, target);
  if (!migrated.ok) return migrated;
  // Do not delete the legacy item here. Even a cleanup operation can invoke
  // SecurityAgent for an unusual ACL, and zero UI is more important than
  // removing a harmless orphan. Relay never consults it again after migration.
  return legacy;
}
function deleteCredential(options = {}) {
  if (platformOf(options) !== "darwin") return operation("delete", "", options);
  return localStore.deleteCredential(credentialOptions(options));
}

module.exports = {
  SERVICE,
  ACCOUNT,
  writeCredential,
  readCredential,
  deleteCredential,
  writeDeviceToken,
  readDeviceToken,
  deleteDeviceToken,
  readLegacyMacCredential,
};
