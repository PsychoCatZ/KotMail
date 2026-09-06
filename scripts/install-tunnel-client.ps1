$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$installDir = Join-Path $projectRoot "data\tools\tunnel-client"
$tempDir = Join-Path $projectRoot "data\downloads\tunnel-client"
$userAgent = @{ "User-Agent" = "KotMail-Setup" }

$release = Invoke-RestMethod -Uri "https://api.github.com/repos/openai/tunnel-client/releases/latest" -Headers $userAgent
$assetName = "tunnel-client-$($release.tag_name)-windows-amd64.zip"
$asset = $release.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
$checksums = $release.assets | Where-Object { $_.name -eq "SHA256SUMS.txt" } | Select-Object -First 1

if (-not $asset -or -not $checksums) {
  throw "Official Windows tunnel-client release assets were not found"
}

New-Item -ItemType Directory -Force -Path $installDir, $tempDir | Out-Null
$archivePath = Join-Path $tempDir $assetName
$checksumPath = Join-Path $tempDir "SHA256SUMS.txt"

Invoke-WebRequest -Uri $asset.browser_download_url -Headers $userAgent -OutFile $archivePath
Invoke-WebRequest -Uri $checksums.browser_download_url -Headers $userAgent -OutFile $checksumPath

$checksumLine = Get-Content -LiteralPath $checksumPath | Where-Object { $_ -match [regex]::Escape($assetName) } | Select-Object -First 1
if (-not $checksumLine) { throw "Checksum for $assetName was not found" }
$expectedHash = ($checksumLine -split "\s+")[0].ToUpperInvariant()
$actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToUpperInvariant()
if ($actualHash -ne $expectedHash) { throw "SHA256 mismatch for official tunnel-client archive" }

Expand-Archive -LiteralPath $archivePath -DestinationPath $installDir -Force
$binary = Get-ChildItem -LiteralPath $installDir -Filter "tunnel-client*.exe" -Recurse | Select-Object -First 1
if (-not $binary) { throw "tunnel-client executable was not found in the archive" }

Write-Output "Installed $($release.tag_name): $($binary.FullName)"
& $binary.FullName --version
