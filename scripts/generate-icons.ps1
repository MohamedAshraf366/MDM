$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root 'assets'
New-Item -ItemType Directory -Force -Path $assets | Out-Null

function New-RoundedPath {
  param(
    [float]$X,
    [float]$Y,
    [float]$Width,
    [float]$Height,
    [float]$Radius
  )
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $Radius * 2
  $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

$master = New-Object System.Drawing.Bitmap 1024, 1024, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($master)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.Clear([System.Drawing.Color]::Transparent)

$backgroundRect = New-Object System.Drawing.RectangleF 32, 32, 960, 960
$backgroundPath = New-RoundedPath 32 32 960 960 218
$backgroundBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $backgroundRect,
  [System.Drawing.Color]::FromArgb(255, 24, 186, 168),
  [System.Drawing.Color]::FromArgb(255, 5, 108, 100),
  45.0
)
$graphics.FillPath($backgroundBrush, $backgroundPath)

$graphics.SetClip($backgroundPath)
$glowBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(44, 255, 255, 255))
$graphics.FillEllipse($glowBrush, -220, -280, 1120, 780)
$shadeBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(40, 0, 56, 52))
$graphics.FillEllipse($shadeBrush, 160, 700, 980, 520)
$graphics.ResetClip()

$edgePen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(48, 255, 255, 255)), 8
$graphics.DrawPath($edgePen, $backgroundPath)

$white = [System.Drawing.Color]::FromArgb(255, 246, 255, 253)
$shaftPen = New-Object System.Drawing.Pen $white, 92
$shaftPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$shaftPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$graphics.DrawLine($shaftPen, 512, 235, 512, 590)

$arrowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$arrowPoints = @(
  (New-Object System.Drawing.PointF 285, 520),
  (New-Object System.Drawing.PointF 739, 520),
  (New-Object System.Drawing.PointF 512, 800)
)
$arrowPath.AddPolygon($arrowPoints)
$whiteBrush = New-Object System.Drawing.SolidBrush $white
$graphics.FillPath($whiteBrush, $arrowPath)

$trayColor = [System.Drawing.Color]::FromArgb(235, 246, 255, 253)
$trayPen = New-Object System.Drawing.Pen $trayColor, 72
$trayPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$trayPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$graphics.DrawLine($trayPen, 292, 866, 732, 866)

$graphics.Dispose()

function Save-ScaledPng {
  param(
    [System.Drawing.Bitmap]$Source,
    [int]$Size,
    [string]$Path
  )
  $bitmap = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $graphics.DrawImage($Source, 0, 0, $Size, $Size)
  $graphics.Dispose()
  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
}

function Get-PngBytes {
  param([System.Drawing.Bitmap]$Source, [int]$Size)
  $bitmap = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $graphics.DrawImage($Source, 0, 0, $Size, $Size)
  $graphics.Dispose()
  $stream = New-Object System.IO.MemoryStream
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
  $bytes = $stream.ToArray()
  $stream.Dispose()
  Write-Output -NoEnumerate $bytes
}

Save-ScaledPng $master 512 (Join-Path $assets 'icon.png')
Save-ScaledPng $master 32 (Join-Path $assets 'tray.png')
Save-ScaledPng $master 64 (Join-Path $assets 'tray@2x.png')

$extensionIcons = Join-Path $root 'extension/icons'
New-Item -ItemType Directory -Force -Path $extensionIcons | Out-Null
foreach ($size in @(16, 32, 48, 128)) {
  Save-ScaledPng $master $size (Join-Path $extensionIcons "icon$size.png")
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = @()
foreach ($size in $sizes) {
  [byte[]]$pngBytes = Get-PngBytes $master $size
  if ($pngBytes.Length -lt 64) {
    throw "The generated $size x $size PNG is invalid."
  }
  $images += [PSCustomObject]@{
    Size = $size
    Bytes = $pngBytes
  }
}

$icoPath = Join-Path $assets 'icon.ico'
$file = [System.IO.File]::Open($icoPath, [System.IO.FileMode]::Create)
$writer = New-Object System.IO.BinaryWriter $file
try {
  $writer.Write([UInt16]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]$images.Count)
  $offset = 6 + (16 * $images.Count)
  foreach ($image in $images) {
    $dimension = if ($image.Size -ge 256) { 0 } else { $image.Size }
    $writer.Write([byte]$dimension)
    $writer.Write([byte]$dimension)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]32)
    $writer.Write([UInt32]$image.Bytes.Length)
    $writer.Write([UInt32]$offset)
    $offset += $image.Bytes.Length
  }
  foreach ($image in $images) {
    [byte[]]$pngBytes = $image.Bytes
    $writer.Write($pngBytes, 0, $pngBytes.Length)
  }
  if ($file.Length -ne $offset) {
    throw "The ICO file is incomplete ($($file.Length) bytes, expected $offset)."
  }
} finally {
  $writer.Dispose()
  $file.Dispose()
}

$master.Dispose()

Write-Host "Generated icon.png, tray.png, tray@2x.png, and icon.ico in $assets"
