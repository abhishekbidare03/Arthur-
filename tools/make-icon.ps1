<#
    Builds Arthur's Windows icon from `frontend/logo/logo.png`.

    A `.ico` is what Explorer, the taskbar and the Start menu read; a 1254x1254
    PNG is not. Rather than committing a binary nobody can diff or regenerate,
    this rebuilds it from the source logo - and does it with System.Drawing,
    which ships with Windows, so packaging costs no image dependency.

    Writes:
      assets/Arthur.ico              the shortcut and taskbar icon
      frontend/public/favicon.ico    the same file, for the app window's tab icon

    Usage:  powershell -ExecutionPolicy Bypass -File tools\make-icon.ps1
#>

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root   = Split-Path $PSScriptRoot -Parent
$source = Join-Path $root 'frontend\logo\logo.png'
$icoOut = Join-Path $root 'assets\Arthur.ico'
$favOut = Join-Path $root 'frontend\public\favicon.ico'

if (-not (Test-Path $source)) { throw "No logo at $source" }

New-Item -ItemType Directory -Force (Split-Path $icoOut) | Out-Null
New-Item -ItemType Directory -Force (Split-Path $favOut) | Out-Null

# Every size Windows asks for, from the 16px Explorer list to the 256px preview.
# One image scaled by the shell looks soft at small sizes; a real entry per size
# is the difference between a crisp taskbar icon and a smudge.
$sizes = @(16, 24, 32, 48, 64, 128, 256)

$original = [System.Drawing.Image]::FromFile($source)
$images = @()

try {
    foreach ($size in $sizes) {
        $bitmap = New-Object System.Drawing.Bitmap $size, $size
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.InterpolationMode = 'HighQualityBicubic'
            $graphics.SmoothingMode = 'HighQuality'
            $graphics.PixelOffsetMode = 'HighQuality'
            $graphics.DrawImage($original, 0, 0, $size, $size)
        } finally {
            $graphics.Dispose()
        }

        $stream = New-Object System.IO.MemoryStream
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $bitmap.Dispose()
        $images += , $stream.ToArray()
        $stream.Dispose()
    }
} finally {
    $original.Dispose()
}

# ICO container: a 6-byte header, then one 16-byte directory entry per image,
# then the image payloads. PNG-compressed entries are what keeps a 256px icon
# from costing 256 KB of raw BGRA.
$out = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter $out
try {
    $writer.Write([UInt16]0)               # reserved
    $writer.Write([UInt16]1)               # type: icon
    $writer.Write([UInt16]$sizes.Count)

    $offset = 6 + (16 * $sizes.Count)
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        # 256 is stored as 0 - the field is one byte, so 256 does not fit.
        $dimension = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
        $writer.Write([Byte]$dimension)    # width
        $writer.Write([Byte]$dimension)    # height
        $writer.Write([Byte]0)             # palette size (0 = truecolour)
        $writer.Write([Byte]0)             # reserved
        $writer.Write([UInt16]1)           # colour planes
        $writer.Write([UInt16]32)          # bits per pixel
        $writer.Write([UInt32]$images[$i].Length)
        $writer.Write([UInt32]$offset)
        $offset += $images[$i].Length
    }

    foreach ($image in $images) { $writer.Write($image) }
    $writer.Flush()

    $bytes = $out.ToArray()
    [System.IO.File]::WriteAllBytes($icoOut, $bytes)
    [System.IO.File]::WriteAllBytes($favOut, $bytes)
} finally {
    $writer.Dispose()
    $out.Dispose()
}

Write-Host "  Icon            $([Math]::Round($bytes.Length / 1KB)) KB, $($sizes.Count) sizes" -ForegroundColor Green
