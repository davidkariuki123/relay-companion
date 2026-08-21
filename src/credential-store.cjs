"use strict";

const { spawnSync } = require("node:child_process");

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
  return {
    ok: !result?.error && result?.status === 0,
    value: String(result?.stdout || "").replace(/[\r\n]+$/, ""),
    detail: result?.error?.message || String(result?.stderr || "").trim(),
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
 'read' { $v=[RelayCredential]::Read($env:RELAY_CREDENTIAL_TARGET); if($null -ne $v){[Console]::Out.Write($v)} }
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
        return { ok: false, value: "", detail: "credential exceeds the macOS secure prompt limit" };
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
      if (!writeResult.ok) return writeResult;
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
      return { ok: false, value: "", detail: verifyResult.detail || "native credential verification failed" };
    }
    let args;
    if (action === "read") args = ["find-generic-password", "-s", credentialService, "-a", credentialAccount, "-w"];
    else args = ["delete-generic-password", "-s", credentialService, "-a", credentialAccount];
    const result = resultOf("/usr/bin/security", args, options);
    if (action === "delete" && !result.ok && /could not be found|-25300/i.test(result.detail)) return { ok: true, value: "" };
    return result;
  }
  if (platform === "win32") {
    // TargetName, not UserName, is the Credential Manager uniqueness key. Keep
    // the historical device-token target unchanged while namespacing any
    // additional Relay capabilities under the same product identity.
    const target = credentialService === SERVICE && credentialAccount === ACCOUNT
      ? SERVICE
      : `${credentialService}/${credentialAccount}`;
    return resultOf("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT], {
      ...options,
      env: { ...(options.env || process.env), RELAY_CREDENTIAL_ACTION: action, RELAY_CREDENTIAL_TARGET: target,
        RELAY_CREDENTIAL_ACCOUNT: credentialAccount },
      ...(action === "write" ? { input: secret } : {}),
    });
  }
  return { ok: false, value: "", detail: "native credential store unsupported" };
}

function writeDeviceToken(token, options) {
  return String(token || "") ? operation("write", String(token), options) : { ok: false, detail: "empty credential" };
}
function readDeviceToken(options) { return operation("read", "", options); }
function deleteDeviceToken(options) { return operation("delete", "", options); }

function writeCredential(secret, options) {
  return String(secret || "") ? operation("write", String(secret), options) : { ok: false, detail: "empty credential" };
}
function readCredential(options) { return operation("read", "", options); }
function deleteCredential(options) { return operation("delete", "", options); }

module.exports = {
  SERVICE,
  ACCOUNT,
  writeCredential,
  readCredential,
  deleteCredential,
  writeDeviceToken,
  readDeviceToken,
  deleteDeviceToken,
};
