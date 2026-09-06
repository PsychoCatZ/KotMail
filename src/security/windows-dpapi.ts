import { spawn } from "node:child_process";

const entropy = "KotMail/runtime-key/v1";
const protectScript = `Add-Type -AssemblyName System.Security;$inputStream=[Console]::OpenStandardInput();$memory=New-Object IO.MemoryStream;$inputStream.CopyTo($memory);$extra=[Text.Encoding]::UTF8.GetBytes('${entropy}');$sealed=[Security.Cryptography.ProtectedData]::Protect($memory.ToArray(),$extra,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($sealed))`;
const unprotectScript = `Add-Type -AssemblyName System.Security;$encoded=[Console]::In.ReadToEnd();$sealed=[Convert]::FromBase64String($encoded);$extra=[Text.Encoding]::UTF8.GetBytes('${entropy}');$plain=[Security.Cryptography.ProtectedData]::Unprotect($sealed,$extra,[Security.Cryptography.DataProtectionScope]::CurrentUser);$output=[Console]::OpenStandardOutput();$output.Write($plain,0,$plain.Length)`;

async function run(script: string, input: Buffer): Promise<Buffer> {
  if (process.platform !== "win32") throw new Error("Windows DPAPI is only available on Windows");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error("Windows credential protection timed out")); }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16_384) { child.kill(); return; }
      chunks.push(chunk);
    });
    child.once("error", () => { clearTimeout(timer); reject(new Error("Windows credential protection is unavailable")); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code !== 0 || size > 16_384) reject(new Error("Windows credential protection failed"));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}

export async function protectForCurrentUser(secret: Buffer): Promise<string> {
  const output = await run(protectScript, secret);
  const value = output.toString("ascii").trim();
  if (!/^[A-Za-z0-9+/=]{40,16384}$/.test(value)) throw new Error("Windows credential protection returned invalid data");
  return value;
}

export async function unprotectForCurrentUser(value: string): Promise<Buffer> {
  if (!/^[A-Za-z0-9+/=]{40,16384}$/.test(value)) throw new Error("Invalid protected credential");
  return run(unprotectScript, Buffer.from(value, "ascii"));
}
