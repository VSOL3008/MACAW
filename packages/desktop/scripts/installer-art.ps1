param(
  [string]$Source = (Join-Path $PSScriptRoot "..\app-icon.png"),
  [string]$Output = (Join-Path $PSScriptRoot "..\src-tauri\assets")
)

Add-Type -AssemblyName System.Drawing

function Round([System.Drawing.RectangleF]$box, [float]$radius) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $size = $radius * 2
  $path.AddArc($box.X, $box.Y, $size, $size, 180, 90)
  $path.AddArc($box.Right - $size, $box.Y, $size, $size, 270, 90)
  $path.AddArc($box.Right - $size, $box.Bottom - $size, $size, $size, 0, 90)
  $path.AddArc($box.X, $box.Bottom - $size, $size, $size, 90, 90)
  $path.CloseFigure()
  return $path
}

function Canvas([int]$width, [int]$height) {
  $img = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $gfx = [System.Drawing.Graphics]::FromImage($img)
  $gfx.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $gfx.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $gfx.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $gfx.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  return @($img, $gfx)
}

function Text($gfx, [string]$value, [float]$size, [System.Drawing.FontStyle]$style, [string]$color, [float]$x, [float]$y) {
  $font = [System.Drawing.Font]::new("Segoe UI", $size, $style, [System.Drawing.GraphicsUnit]::Pixel)
  $brush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($color))
  $gfx.DrawString($value, $font, $brush, $x, $y)
  $brush.Dispose()
  $font.Dispose()
}

$icon = [System.Drawing.Image]::FromFile((Resolve-Path $Source))

$pair = Canvas 150 57
$head = $pair[0]
$gfx = $pair[1]
$gfx.Clear([System.Drawing.ColorTranslator]::FromHtml("#F7F9FA"))
$gfx.FillRectangle([System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#DCE3E8")), 0, 56, 150, 1)
$gfx.DrawImage($icon, [System.Drawing.Rectangle]::new(10, 8, 40, 40))
Text $gfx "MACAW" 15 ([System.Drawing.FontStyle]::Bold) "#273442" 58 8
Text $gfx "D E S K T O P" 7 ([System.Drawing.FontStyle]::Bold) "#667788" 59 31
$head.Save((Join-Path $Output "nsis-header.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
$gfx.Dispose()
$head.Dispose()

$pair = Canvas 164 314
$side = $pair[0]
$gfx = $pair[1]
$box = [System.Drawing.Rectangle]::new(0, 0, 164, 314)
$fade = [System.Drawing.Drawing2D.LinearGradientBrush]::new($box, [System.Drawing.ColorTranslator]::FromHtml("#18242F"), [System.Drawing.ColorTranslator]::FromHtml("#2B3946"), 90)
$gfx.FillRectangle($fade, $box)
$fade.Dispose()

$glow = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(18, 255, 255, 255))
$gfx.FillEllipse($glow, 74, -54, 150, 150)
$glow.Dispose()
Text $gfx "MACAW" 15 ([System.Drawing.FontStyle]::Bold) "#F6F8FA" 18 20
Text $gfx "D E S K T O P" 7 ([System.Drawing.FontStyle]::Bold) "#9EACB9" 19 43

$shadow = Round ([System.Drawing.RectangleF]::new(24, 75, 120, 120)) 18
$gfx.FillPath([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(32, 0, 0, 0)), $shadow)
$shadow.Dispose()
$card = Round ([System.Drawing.RectangleF]::new(20, 71, 120, 120)) 18
$gfx.FillPath([System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#F7F9FA")), $card)
$card.Dispose()
$gfx.DrawImage($icon, [System.Drawing.Rectangle]::new(36, 87, 88, 88))

Text $gfx "YOUR AI WORKSPACE" 10 ([System.Drawing.FontStyle]::Bold) "#F6F8FA" 18 218
Text $gfx "Build. Automate. Create." 9 ([System.Drawing.FontStyle]::Regular) "#B9C4CD" 18 240
$line = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml("#667788"), 1)
$gfx.DrawLine($line, 18, 278, 146, 278)
$line.Dispose()
Text $gfx "LOCAL-FIRST DESKTOP" 7 ([System.Drawing.FontStyle]::Bold) "#9EACB9" 18 287

$side.Save((Join-Path $Output "nsis-sidebar.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
$gfx.Dispose()
$side.Dispose()
$icon.Dispose()
