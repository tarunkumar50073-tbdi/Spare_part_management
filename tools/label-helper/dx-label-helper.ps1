# DX Store label print helper (5 Nov 2026).
#
# The store wants labels to come straight out of the label printer when Print
# is pressed: "ye a4 printer nhi jo ye popup aayega, print mtlb sidha print".
# A browser cannot print without its print window, and it cannot tell the
# printer the label size, so the GoDEX label came out cut on a 104 x 102 mm
# page. This small helper runs on the PC the printer is plugged into. The app
# (in that PC's browser) sends it the labels as pictures with their size in
# mm, and the helper prints them through the printer's Windows driver at
# exactly that size: no print window, no header or footer, no page-size
# setting in the driver.
#
# It only listens on this PC (127.0.0.1), answers only the DX Store app's own
# addresses (see $AllowedOrigins), and does nothing but print and list
# printers. install-autostart.bat makes it start hidden with Windows
# (start-label-helper-hidden.vbs); start-label-helper.bat runs it in a window.
param(
  [int]$Port = 9123,
  # Allowed web addresses: the live site, and the app on this PC or the plant LAN.
  [string[]]$AllowedOrigins = @(
    '^https://digi-store\.dxtbdi\.com$',
    '^http://(localhost|127\.0\.0\.1)(:\d+)?$',
    '^http://192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$'
  )
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$Version = 2

# It runs hidden (start-label-helper-hidden.vbs), so what it does is also kept
# in a small log: %LOCALAPPDATA%\DXStore\label-helper.log (cut at 1 MB).
$LogDir = Join-Path $env:LOCALAPPDATA 'DXStore'
$LogFile = Join-Path $LogDir 'label-helper.log'
function Log([string]$msg, [string]$color = 'Gray') {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Write-Host $line -ForegroundColor $color
  try {
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
    if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 1MB) { Move-Item $LogFile "$LogFile.old" -Force }
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
  } catch { }
}

function Get-Printers {
  $names = @([System.Drawing.Printing.PrinterSettings]::InstalledPrinters)
  $default = (New-Object System.Drawing.Printing.PrinterSettings).PrinterName
  return @{ printers = $names; default = $default }
}

function Send-Labels($req) {
  $printer = [string]$req.printer
  $w = [double]$req.w
  $h = [double]$req.h
  $images = @($req.images)
  if (-not $printer) { throw 'printer is required' }
  if ($w -lt 10 -or $w -gt 200 -or $h -lt 10 -or $h -gt 300) { throw "label size $w x $h mm is out of range" }
  if ($images.Count -lt 1 -or $images.Count -gt 500) { throw 'send 1 to 500 labels' }
  $bitmaps = New-Object System.Collections.Generic.List[System.Drawing.Image]
  foreach ($img in $images) {
    $b64 = ([string]$img) -replace '^data:image/[a-z]+;base64,', ''
    $bytes = [Convert]::FromBase64String($b64)
    $bitmaps.Add([System.Drawing.Image]::FromStream((New-Object System.IO.MemoryStream(, $bytes))))
  }
  $doc = New-Object System.Drawing.Printing.PrintDocument
  $doc.PrinterSettings.PrinterName = $printer
  if (-not $doc.PrinterSettings.IsValid) { throw "printer '$printer' is not installed on this PC" }
  $doc.DocumentName = if ($req.title) { [string]$req.title } else { 'DX Store labels' }
  # The label size on the job itself: hundredths of an inch.
  $paper = New-Object System.Drawing.Printing.PaperSize("DX $w x $h mm", [int][math]::Round($w / 25.4 * 100), [int][math]::Round($h / 25.4 * 100))
  $doc.DefaultPageSettings.PaperSize = $paper
  $doc.DefaultPageSettings.Landscape = $false
  $doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
  $doc.OriginAtMargins = $false
  $script:page = 0
  $doc.add_PrintPage({
    param($sender, $e)
    $g = $e.Graphics
    $g.PageUnit = [System.Drawing.GraphicsUnit]::Millimeter
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
    $g.DrawImage($bitmaps[$script:page], 0, 0, [single]$w, [single]$h)
    $script:page++
    $e.HasMorePages = $script:page -lt $bitmaps.Count
  })
  try { $doc.Print() } finally { foreach ($b in $bitmaps) { $b.Dispose() } }
  return $bitmaps.Count
}

function Write-Response($stream, [int]$code, [string]$status, [string]$origin, [string]$body) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  $head = "HTTP/1.1 $code $status`r`n" +
          "Content-Type: application/json; charset=utf-8`r`n" +
          "Content-Length: $($bytes.Length)`r`n" +
          "Cache-Control: no-store`r`n" +
          "Connection: close`r`n"
  if ($origin) {
    $head += "Access-Control-Allow-Origin: $origin`r`n" +
             "Vary: Origin`r`n" +
             "Access-Control-Allow-Methods: GET, POST, OPTIONS`r`n" +
             "Access-Control-Allow-Headers: Content-Type`r`n" +
             "Access-Control-Allow-Private-Network: true`r`n" +
             "Access-Control-Max-Age: 600`r`n"
  }
  $hb = [System.Text.Encoding]::ASCII.GetBytes($head + "`r`n")
  $stream.Write($hb, 0, $hb.Length)
  if ($bytes.Length) { $stream.Write($bytes, 0, $bytes.Length) }
  $stream.Flush()
}

function Read-Request($stream) {
  # Headers up to the blank line, then the body by Content-Length.
  $buf = New-Object System.IO.MemoryStream
  $one = New-Object byte[] 1
  while ($true) {
    $n = $stream.Read($one, 0, 1)
    if ($n -le 0) { return $null }
    $buf.WriteByte($one[0])
    $len = $buf.Length
    if ($len -ge 4) {
      $a = $buf.GetBuffer()
      if ($a[$len - 4] -eq 13 -and $a[$len - 3] -eq 10 -and $a[$len - 2] -eq 13 -and $a[$len - 1] -eq 10) { break }
    }
    if ($len -gt 65536) { throw 'headers too long' }
  }
  $text = [System.Text.Encoding]::ASCII.GetString($buf.ToArray())
  $lines = $text -split "`r`n"
  $first = $lines[0] -split ' '
  $headers = @{}
  foreach ($l in $lines[1..($lines.Count - 1)]) {
    $i = $l.IndexOf(':')
    if ($i -gt 0) { $headers[$l.Substring(0, $i).Trim().ToLower()] = $l.Substring($i + 1).Trim() }
  }
  $body = ''
  $cl = 0
  if ($headers['content-length']) { $cl = [int]$headers['content-length'] }
  if ($cl -gt 50MB) { throw 'body too large' }
  if ($cl -gt 0) {
    $data = New-Object byte[] $cl
    $got = 0
    while ($got -lt $cl) {
      $n = $stream.Read($data, $got, $cl - $got)
      if ($n -le 0) { break }
      $got += $n
    }
    $body = [System.Text.Encoding]::UTF8.GetString($data, 0, $got)
  }
  return @{ method = $first[0]; path = ($first[1] -split '\?')[0]; headers = $headers; body = $body }
}

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
try { $listener.Start() } catch {
  Log "Port $Port is busy - the label helper is probably running already." 'Yellow'
  exit 1
}
$Host.UI.RawUI.WindowTitle = "DX Store label helper (port $Port)"
Log "DX Store label helper v$Version listening on http://127.0.0.1:$Port" 'Green'
$p = Get-Printers
Log ("Printers: " + ($p.printers -join ', '))

while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $client.ReceiveTimeout = 15000
    $stream = $client.GetStream()
    $req = Read-Request $stream
    if ($null -eq $req) { continue }
    $origin = $req.headers['origin']
    $allowed = $true
    if ($origin) { $allowed = @($AllowedOrigins | Where-Object { $origin -match $_ }).Count -gt 0 }
    if (-not $allowed) {
      Write-Response $stream 403 'Forbidden' $null '{"ok":false,"error":"this address may not print here"}'
      Log "refused $origin" 'Yellow'
      continue
    }
    $o = if ($origin) { $origin } else { $null }
    switch -Regex ("$($req.method) $($req.path)") {
      '^OPTIONS ' { Write-Response $stream 204 'No Content' $o ''; break }
      '^GET /status$' {
        $p = Get-Printers
        $out = @{ ok = $true; helper = 'dx-label-helper'; version = $Version; printers = $p.printers; default = $p.default }
        Write-Response $stream 200 'OK' $o ($out | ConvertTo-Json -Compress -Depth 4); break
      }
      '^POST /print$' {
        try {
          $job = $req.body | ConvertFrom-Json
          $n = Send-Labels $job
          Log "printed $n label(s) $($job.w) x $($job.h) mm on $($job.printer)"
          Write-Response $stream 200 'OK' $o (@{ ok = $true; printed = $n } | ConvertTo-Json -Compress)
        } catch {
          $msg = $_.Exception.Message -replace '"', "'"
          Log "print failed: $msg" 'Red'
          Write-Response $stream 400 'Bad Request' $o (@{ ok = $false; error = $msg } | ConvertTo-Json -Compress)
        }
        break
      }
      default { Write-Response $stream 404 'Not Found' $o '{"ok":false,"error":"not found"}' }
    }
  } catch {
    Log "request error: $($_.Exception.Message)" 'Red'
  } finally {
    $client.Close()
  }
}
