param(
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
if (-not $Version) {
  $Version = (Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
}
# The website and release artifacts use the short form (2.4), while package.json needs full semver (2.4.0).
if ($Version -match '\.0$') {
  $Version = $Version -replace '\.0$', ''
}
$source = Join-Path $root "extension"
$firefox = Join-Path $source "firefox"
$release = Join-Path $root "release\extensions"
$staging = Join-Path $release "staging"
$chromeStage = Join-Path $staging "chromium"
$firefoxStage = Join-Path $staging "firefox"

& node (Join-Path $PSScriptRoot "build-extension.mjs")
if ($LASTEXITCODE -ne 0) {
  throw "Extension synchronization failed."
}

Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $chromeStage, $firefoxStage -Force | Out-Null

Get-ChildItem -LiteralPath $source -Force |
  Where-Object { $_.Name -ne "firefox" } |
  ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $chromeStage -Recurse -Force
  }

Get-ChildItem -LiteralPath $firefox -Force |
  ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $firefoxStage -Recurse -Force
  }

$chromeZip = Join-Path $release "mdm-chromium-$Version.zip"
$firefoxZip = Join-Path $release "mdm-firefox-$Version.zip"

Remove-Item -LiteralPath $chromeZip, $firefoxZip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $chromeStage "*") -DestinationPath $chromeZip -CompressionLevel Optimal
Compress-Archive -Path (Join-Path $firefoxStage "*") -DestinationPath $firefoxZip -CompressionLevel Optimal

Remove-Item -LiteralPath $staging -Recurse -Force

Write-Output $chromeZip
Write-Output $firefoxZip
