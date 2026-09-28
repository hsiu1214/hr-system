<#
  serve_hr.ps1 ─ HR 系統「本機伺服器」啟動器（免安裝、零相依）
  ---------------------------------------------------------------
  為什麼需要它？
    瀏覽器只允許「安全來源」使用 File System Access API（直接寫回磁碟）。
    file:// (雙擊開啟) 不是安全來源，所以「直接覆寫主檔」失效；
    而 http://localhost 算安全來源 → 該功能即可正常使用。

  特性：
    - 只用 Windows 內建 PowerShell + HttpListener，不需安裝 Python / Node。
    - 僅綁定 localhost（不對外開放），一般不需要管理員權限、也不會觸發防火牆提示。
    - 關閉這個視窗（或按 Ctrl+C）即停止；重新使用請再執行「啟動HR系統.bat」。
    - 只提供「讀取」：伺服器不會修改任何檔案。
#>
param([switch]$NoBrowser)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { [Console]::InputEncoding  = [System.Text.Encoding]::UTF8 } catch {}
# 讓主控台以 UTF-8 顯示（.bat 已先 chcp 65001，這裡再保險一次）
try { $null = & "$env:SystemRoot\System32\chcp.com" 65001 } catch {}

$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
if (-not $root) { $root = (Get-Location).Path }
$rootFull = [System.IO.Path]::GetFullPath($root)

function Stop-Here([int]$code, [string]$msg) {
  if ($msg) { Write-Host $msg -ForegroundColor Red }
  Write-Host ""
  try { [void](Read-Host "按 Enter 結束") } catch {}
  exit $code
}

# ---- 入口檔（檔名含中文，故用掃描取得，不寫死）----
$htmls = @(Get-ChildItem -LiteralPath $rootFull -Filter *.html -File -ErrorAction SilentlyContinue)
if ($htmls.Count -eq 0) {
  Stop-Here 1 "[X] 找不到 .html 檔。本程式必須與 HR系統.html 放在同一個資料夾。"
}
$entry = ($htmls | Where-Object { $_.Name -match 'HR' -and $_.Name -notmatch 'diag' } | Select-Object -First 1)
if (-not $entry) { $entry = $htmls | Where-Object { $_.Name -notmatch 'diag' } | Select-Object -First 1 }
if (-not $entry) { $entry = $htmls[0] }

# ---- 找一個可用埠（8777 起，最多試到 8787）----
$listener = $null
$port = 0
foreach ($p in 8777..8787) {
  try {
    $try = New-Object System.Net.HttpListener
    $try.Prefixes.Add("http://localhost:$p/")
    $try.Start()
    $listener = $try
    $port = $p
    break
  } catch {
    try { $try.Close() } catch {}
  }
}
if (-not $listener) {
  Stop-Here 1 "[X] 8777-8787 連接埠皆被占用，請關閉其他程式後再試一次。"
}

$url = "http://localhost:$port/" + [Uri]::EscapeDataString($entry.Name)

$mime = @{
  ".html" = "text/html; charset=utf-8"
  ".htm"  = "text/html; charset=utf-8"
  ".js"   = "application/javascript; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".txt"  = "text/plain; charset=utf-8"
  ".csv"  = "text/csv; charset=utf-8"
  ".xlsx" = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ".xls"  = "application/vnd.ms-excel"
  ".png"  = "image/png"
  ".jpg"  = "image/jpeg"
  ".ico"  = "image/x-icon"
}

Write-Host ""
Write-Host "===========================================================" -ForegroundColor Cyan
Write-Host " HR 系統 本機伺服器已啟動（安全來源模式）" -ForegroundColor Green
Write-Host "===========================================================" -ForegroundColor Cyan
Write-Host " 入口網址： $url" -ForegroundColor Yellow
Write-Host " 資料夾  ： $rootFull"
Write-Host ""
Write-Host " 已可使用：『直接覆寫主檔』（就地更新原檔，並自動下載備份）" -ForegroundColor Green
Write-Host " 請用這個網址操作，勿再直接用檔案總管雙擊 HTML。" -ForegroundColor Gray
Write-Host " 停止方式：關閉本視窗，或按 Ctrl+C。" -ForegroundColor Gray
Write-Host ""
Write-Host " ★ 注意：以本機伺服器開啟時的瀏覽器資料，與雙擊(file://)模式" -ForegroundColor DarkYellow
Write-Host "   各自獨立 → 第一次使用請按『從雲端同步打卡』一次。" -ForegroundColor DarkYellow
Write-Host ""

if (-not $NoBrowser) {
  try { Start-Process $url } catch { Write-Host "（無法自動開啟瀏覽器，請自行複製上方網址貼到 Chrome / Edge）" -ForegroundColor DarkYellow }
}

while ($listener.IsListening) {
  $ctx = $null
  try { $ctx = $listener.GetContext() } catch { break }
  if (-not $ctx) { break }
  $req = $ctx.Request
  $res = $ctx.Response
  try {
    $rel = [Uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart("/")
    if ([string]::IsNullOrWhiteSpace($rel)) { $rel = $entry.Name }

    $cand = [System.IO.Path]::GetFullPath((Join-Path $rootFull $rel))
    $inside = $cand.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)
    if (-not $inside) {
      $res.StatusCode = 403
      $msg = [System.Text.Encoding]::UTF8.GetBytes("403 Forbidden")
      $res.ContentType = "text/plain; charset=utf-8"
      $res.ContentLength64 = $msg.Length
      $res.OutputStream.Write($msg, 0, $msg.Length)
    }
    elseif (Test-Path -LiteralPath $cand -PathType Leaf) {
      $bytes = [System.IO.File]::ReadAllBytes($cand)
      $ext = [System.IO.Path]::GetExtension($cand).ToLowerInvariant()
      if ($mime.ContainsKey($ext)) { $res.ContentType = $mime[$ext] } else { $res.ContentType = "application/octet-stream" }
      $res.Headers.Add("Cache-Control", "no-store")
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
      Write-Host ("  200  " + $rel) -ForegroundColor DarkGray
    }
    else {
      $res.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $rel")
      $res.ContentType = "text/plain; charset=utf-8"
      $res.ContentLength64 = $msg.Length
      $res.OutputStream.Write($msg, 0, $msg.Length)
      Write-Host ("  404  " + $rel) -ForegroundColor DarkYellow
    }
  } catch {
    try { $res.StatusCode = 500 } catch {}
  } finally {
    try { $res.OutputStream.Close() } catch {}
    try { $res.Close() } catch {}
  }
}

try { $listener.Stop(); $listener.Close() } catch {}
Write-Host ""
Write-Host "本機伺服器已停止。" -ForegroundColor Cyan
exit 0
