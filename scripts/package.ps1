# Zip the unpacked extension for the store / sharing.
#
#   pwsh scripts/package.ps1
#
# Produces dist/MultiChatAI-<version>.zip with manifest.json at the archive root
# (the layout the Edge Add-ons and Chrome Web Store upload forms expect).

param(
  [string]$OutDir = "dist"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$ext = Join-Path $root "extension"
$manifestPath = Join-Path $ext "manifest.json"

if (-not (Test-Path $manifestPath)) {
  throw "manifest.json not found at $manifestPath"
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$zip = Join-Path (Join-Path $root $OutDir) ("MultiChatAI-{0}.zip" -f $manifest.version)

New-Item -ItemType Directory -Force -Path (Join-Path $root $OutDir) | Out-Null
if (Test-Path $zip) { Remove-Item $zip -Force }

Compress-Archive -Path (Join-Path $ext "*") -DestinationPath $zip -CompressionLevel Optimal

$size = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Write-Host ("packed {0} v{1} -> {2} ({3} KB)" -f $manifest.name, $manifest.version, $zip, $size)
