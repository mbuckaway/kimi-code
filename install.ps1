<#
.SYNOPSIS
  Native installer for the mbuckaway/kimi-code fork (Windows PowerShell 5.1+).

.EXAMPLE
  irm https://mbuckaway.github.io/kimi-code/install.ps1 | iex

.DESCRIPTION
  Downloads the latest fork release from GitHub Releases (version discovered
  via the GitHub Pages update channel) and installs it as
  %USERPROFILE%\.kimi-code\bin\kimi.exe, adding that directory to the user PATH.

  Trust model (read this before piping it to iex): this script, the version
  pointer, and the expected SHA-256 all come from the SAME GitHub Pages origin,
  and that origin is refreshed by the same workflow that publishes the release
  zips. So the checksum below only proves the zip arrived intact and was not
  swapped out on its own — it is NOT independent verification. Fork builds carry
  no code signature (there are no signing secrets on the fork, by design).
#>

$ErrorActionPreference = 'Stop'

# PowerShell 5.1 on older Windows may not negotiate TLS 1.2 by default.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$ChannelBase = 'https://mbuckaway.github.io/kimi-code'
$Repo = 'mbuckaway/kimi-code'
$HomeDir = if ($null -ne $env:KIMI_CODE_HOME) { $env:KIMI_CODE_HOME } else { Join-Path $env:USERPROFILE '.kimi-code' }
$BinDir = Join-Path $HomeDir 'bin'

function Die($msg) {
  Write-Host "error: $msg" -ForegroundColor Red
  exit 1
}

function Get-Target {
  $rawArch = try {
    [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  } catch {
    # Pre-4.7.1 .NET Framework: detect WOW64 (32-bit PS on 64-bit Windows) so we
    # don't misreport x64 as x86. PROCESSOR_ARCHITEW6432 is only set under WOW64.
    if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  }

  $arch = switch ($rawArch) {
    'X64'   { 'x64' }
    'AMD64' { 'x64' }
    'Arm64' { 'arm64' }
    default { Die "unsupported architecture: $rawArch" }
  }

  return "win32-$arch"
}

$target = Get-Target

$version = (Invoke-RestMethod "$ChannelBase/latest").Trim()
if (-not $version) {
  Die "could not read latest version from $ChannelBase/latest"
}

$tag = "v$version"
$zip = "kimi-code-$target.zip"
$url = "https://github.com/$Repo/releases/download/$tag/$zip"

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("kimi-code-install-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
  Write-Host "Installing kimi-code $version ($target) from $Repo..."
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile (Join-Path $tmp $zip)

  $expected = ((Invoke-RestMethod "$ChannelBase/sha256/$target.sha256") -split '\s+')[0]
  $actual = (Get-FileHash (Join-Path $tmp $zip) -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expected.ToLower()) {
    Die "checksum mismatch for $zip`n  expected: $expected`n  actual:   $actual"
  }

  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  $extract = Join-Path $tmp 'extract'
  Expand-Archive -Path (Join-Path $tmp $zip) -DestinationPath $extract
  Copy-Item -Path (Join-Path $extract 'kimi.exe') -Destination (Join-Path $BinDir 'kimi.exe') -Force

  if ($env:KIMI_NO_MODIFY_PATH) {
    Write-Host "Skipping PATH update (KIMI_NO_MODIFY_PATH set)"
  } else {
    $current = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($current -and ($current.Split(';') -contains $BinDir)) {
      Write-Host "$BinDir already in user PATH"
    } else {
      $newPath = if ($current) { "$BinDir;$current" } else { $BinDir }
      [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
      Write-Host "Added $BinDir to user PATH (open a new terminal for it to take effect)"
    }
  }

  Write-Host "Installed $BinDir\kimi.exe"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
