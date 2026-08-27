# Minimal static file server for local preview.
#   powershell -ExecutionPolicy Bypass -File serve.ps1 -Port 8787
# Uses TcpListener so it needs no admin URL reservation.

param([int]$Port = 8787)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.ico'  = 'image/x-icon'
}

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
Write-Host "serving $root on http://localhost:$Port/  (Ctrl+C to stop)"

while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $stream = $client.GetStream()
    # Browsers pre-open sockets and sit on them; without a read timeout one
    # idle connection would stall this single-threaded loop forever.
    $stream.ReadTimeout = 3000
    $reader = New-Object System.IO.StreamReader($stream)
    $line = $reader.ReadLine()
    if (-not $line) { $client.Close(); continue }

    $path = ($line -split ' ')[1]
    $path = ($path -split '\?')[0]
    if ($path -eq '/' -or [string]::IsNullOrEmpty($path)) { $path = '/index.html' }
    $path = [System.Uri]::UnescapeDataString($path)

    $file = Join-Path $root ($path.TrimStart('/') -replace '/', '\')
    $full = [System.IO.Path]::GetFullPath($file)

    if ($full.StartsWith($root) -and (Test-Path $full -PathType Leaf)) {
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      $ct = $types[$ext]; if (-not $ct) { $ct = 'application/octet-stream' }
      $head = "HTTP/1.1 200 OK`r`nContent-Type: $ct`r`nContent-Length: $($bytes.Length)`r`nAccess-Control-Allow-Origin: *`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
    } else {
      $bytes = [System.Text.Encoding]::UTF8.GetBytes('404 not found')
      $head = "HTTP/1.1 404 Not Found`r`nContent-Type: text/plain`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n"
    }

    $hb = [System.Text.Encoding]::ASCII.GetBytes($head)
    $stream.Write($hb, 0, $hb.Length)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
  } catch {
    # a dropped connection is not worth stopping the server for
  } finally {
    $client.Close()
  }
}
