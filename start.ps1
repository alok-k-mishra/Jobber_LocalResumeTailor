<#
  Jobber - one-click launcher for Windows / PowerShell
  =====================================================
  Run from the repo folder:
      powershell -ExecutionPolicy Bypass -File .\start.ps1

  Keys:
      R  restart the server
      O  open the app in your browser
      L  tail recent server logs
      I  (re)install dependencies
      Q  stop the server and quit
      ESC  stop the server and quit
#>

$ErrorActionPreference = 'Stop'

# ---- paths -----------------------------------------------------------------
$AppDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$PidFile = Join-Path $AppDir '.jobber-server.pid'
$LogFile = Join-Path $AppDir '.jobber-server.log'

# ---- colors ----------------------------------------------------------------
function Write-Info  { Write-Host "[jobber] $args" -ForegroundColor Cyan }
function Write-Ok    { Write-Host "[jobber] $args" -ForegroundColor Green }
function Write-Warn  { Write-Host "[jobber] $args" -ForegroundColor Yellow }
function Write-Err   { Write-Host "[jobber] $args" -ForegroundColor Red }

# ---- banner ----------------------------------------------------------------
function Show-Banner {
    Write-Host ''
    Write-Host '    ██╗     ██████╗    ██████╗    ██████╗    ███████╗   ██████╗ ' -ForegroundColor Cyan
    Write-Host '    ██║    ██╔═══██╗   ██╔══██╗   ██╔══██╗   ██╔════╝   ██╔══██╗' -ForegroundColor Cyan
    Write-Host '    ██║    ██║   ██║   ██████╔╝   ██████╔╝   █████╗     ██████╔╝' -ForegroundColor Cyan
    Write-Host '    ██║    ██║   ██║   ██╔══██╗   ██╔══██╗   ██╔══╝     ██╔══██╗' -ForegroundColor Cyan
    Write-Host ' ██╗██║    ╚██████╔╝   ██████╔╝   ██████╔╝   ███████╗   ██║  ██║' -ForegroundColor Cyan
    Write-Host ' ╚═╝╚═╝     ╚═════╝    ╚═════╝    ╚═════╝    ╚══════╝   ╚═╝  ╚═╝' -ForegroundColor Cyan
    Write-Host '  privacy-first, evidence-based resume tailoring (powered by local Ollama)' -ForegroundColor DarkGray
    Write-Host ''
}

# ---- helpers ---------------------------------------------------------------
function Get-AppPort {
    $envFile = Join-Path $AppDir '.env'
    if (Test-Path $envFile) {
        $line = Get-Content $envFile | Where-Object { $_ -match '^\s*PORT\s*=' } | Select-Object -First 1
        if ($line) {
            $val = ($line -split '=', 2)[1].Trim().Trim('"').Trim("'")
            if ($val -match '^\d+$') { return [int]$val }
        }
    }
    return 5173
}

function Get-OllamaUrl {
    $envFile = Join-Path $AppDir '.env'
    if (Test-Path $envFile) {
        $line = Get-Content $envFile | Where-Object { $_ -match '^\s*OLLAMA_BASE_URL\s*=' } | Select-Object -First 1
        if ($line) {
            $val = ($line -split '=', 2)[1].Trim().Trim('"').Trim("'")
            if ($val) { return $val }
        }
    }
    return 'http://127.0.0.1:11434'
}

function Is-Running {
    if (-not (Test-Path $PidFile)) { return $false }
    $id = [int](Get-Content $PidFile -ErrorAction SilentlyContinue)
    [bool](Get-Process -Id $id -ErrorAction SilentlyContinue)
}

function Test-Node {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Err "Node.js not found. Install Node.js 20+ from https://nodejs.org"
        return $false
    }
    $v = & node --version 2>$null
    $major = [int]($v.TrimStart('v').Split('.')[0])
    if ($major -lt 20) {
        Write-Err "Found Node $v - Jobber needs Node.js 20+."
        return $false
    }
    Write-Ok "Node $v detected (need >= 20)"
    return $true
}

function Test-Ollama {
    $url = Get-OllamaUrl
    $s = ($url -replace '^https?://', '').TrimEnd('/').Split('/')[0]
    if ($s -match ':(\d+)$') { $hostname = $s -replace ':\d+$', ''; $port = [int]$Matches[1] }
    else { $hostname = $s; $port = 11434 }
    $tcp = New-Object System.Net.Sockets.TcpClient
    try {
        $tcp.Connect($hostname, $port)
        Write-Ok "Ollama reachable at $url"
    } catch {
        Write-Warn "Ollama is NOT reachable at $url (is it running?)"
    } finally {
        $tcp.Close()
    }
}

function Ensure-Deps {
    if (-not (Test-Path (Join-Path $AppDir 'node_modules'))) {
        Write-Warn "node_modules missing - running npm install ..."
        Push-Location $AppDir
        try { & npm install *> $null } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed."; return $false }
    }
    return $true
}

function Wait-Port {
    foreach ($i in 1..60) {
        $tcp = New-Object System.Net.Sockets.TcpClient
        try {
            $tcp.Connect('127.0.0.1', $Script:Port)
            return $true
        } catch {
            Start-Sleep -Milliseconds 500
        } finally {
            $tcp.Close()
        }
    }
    return $false
}

function Start-Server {
    if (Is-Running) {
        Write-Warn "Server is already running (pid $([int](Get-Content $PidFile)))"
        return
    }
    Write-Info "Starting Jobber on port $($Script:Port) ..."
    $nodeExe = (Get-Command node).Source
    $errLog  = Join-Path $AppDir '.jobber-server.err.log'
    $proc = Start-Process -FilePath $nodeExe `
        -ArgumentList 'server/index.js' `
        -WorkingDirectory $AppDir `
        -RedirectStandardOutput $LogFile `
        -RedirectStandardError $errLog `
        -PassThru -WindowStyle Hidden
    Set-Content -Path $PidFile -Value $proc.Id
    if (Wait-Port) {
        Write-Ok "Server is up: http://localhost:$($Script:Port)"
    } else {
        Write-Err "Server did not become ready within 30s. See $LogFile and $errLog"
    }
}

function Stop-Server {
    if (Test-Path $PidFile) {
        $id = [int](Get-Content $PidFile)
        if (Get-Process -Id $id -ErrorAction SilentlyContinue) {
            Write-Info "Stopping server (pid $id) ..."
            Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
        }
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }
}

function Restart-Server {
    Write-Info 'Restarting server ...'
    Stop-Server
    Start-Server
}

function Open-Browser {
    Start-Process "http://localhost:$($Script:Port)"
}

function Show-Status {
    if (Is-Running) {
        Write-Ok "Server RUNNING  (pid $([int](Get-Content $PidFile)))  ->  http://localhost:$($Script:Port)"
    } else {
        Write-Warn 'Server STOPPED'
    }
}

function Show-Logs {
    if (Test-Path $LogFile) {
        Write-Host ''
        Get-Content $LogFile -Tail 30
        $errLog = Join-Path $AppDir '.jobber-server.err.log'
        if (Test-Path $errLog) {
            $errs = Get-Content $errLog | Where-Object { $_ }
            if ($errs) {
                Write-Host ''
                Write-Host '-- errors --' -ForegroundColor DarkGray
                $errs | Select-Object -Last 10 | ForEach-Object { Write-Host $_ -ForegroundColor Red }
            }
        }
    } else {
        Write-Warn 'No logs yet.'
    }
}

function Show-Menu {
    Write-Host ''
    Write-Host '── MENU ───────────────────────────────────────────' -ForegroundColor DarkGray
    Write-Host '  R  restart server'
    Write-Host '  O  open browser'
    Write-Host '  L  show recent logs'
    Write-Host '  I  (re)install dependencies'
    Write-Host '  Q  stop server and quit  (or press ESC)'
    Write-Host ''
}

function Main-Loop {
    $quit = $false
    while (-not $quit) {
        Show-Status
        Show-Menu
        Write-Host 'jobber>' -NoNewline -ForegroundColor Green
        $ki = $host.UI.RawUI.ReadKey('NoEcho, IncludeKeyDown')
        $key = $ki.Character.ToString().ToLower()
        Write-Host ''
        if ($ki.Key -eq 'Escape') { Write-Ok 'Goodbye!'; break }
        switch ($key) {
            'r' { Restart-Server; Open-Browser }
            'o' { Open-Browser }
            'l' { Show-Logs }
            'i' { Ensure-Deps }
            'q' { Stop-Server; Write-Ok 'Goodbye!'; $quit = $true }
            default { Write-Warn "Unknown option '$key'." }
        }
    }
}

# ---- main ------------------------------------------------------------------
try {
    $Script:Port = Get-AppPort
    Show-Banner
    if (-not (Test-Node)) { exit 1 }
    if (-not (Ensure-Deps)) { exit 1 }
    Test-Ollama
    Start-Server
    Open-Browser
    Main-Loop
} finally {
    Stop-Server
}