param(
    [ValidateRange(1024, 65535)][int]$Port = 8080,
    [switch]$CheckOnly,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Use modules from this PowerShell, even if another PowerShell installation changed PSModulePath.
foreach ($module in @('Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Archive')) {
    Import-Module "$PSHOME\Modules\$module\$module.psd1" -ErrorAction Stop
}
$appRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$runtimeVersion = '3.14.8'
$archiveName = "python-$runtimeVersion-embeddable-amd64.zip"
$archiveHash = '80292f0e640e373a54bf09f3b94a1472f976f24a10c5bed0d9622e4e44d67447'
$archiveUrl = "https://www.python.org/ftp/python/$runtimeVersion/$archiveName"
$runtimeBase = Join-Path $appRoot '.runtime'
$runtimeDirectory = Join-Path $runtimeBase "python-$runtimeVersion-amd64"
$pythonPath = Join-Path $runtimeDirectory 'python.exe'
$healthCode = 'import sys,http.server,socketserver,json,os,time,webbrowser,threading,io,shutil,urllib.parse,urllib.request,ssl,subprocess,platform,signal,re,traceback,argparse,contextlib,datetime,pathlib,msvcrt; assert sys.version_info[:3] == (3,14,8)'

function Test-AppPython([string]$Executable) {
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { return $false }
    try {
        & $Executable -X utf8 -c $healthCode 2>&1 | Out-Null
        return $LASTEXITCODE -eq 0
    } catch { return $false }
}

function Assert-RuntimeChild([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path)
    $prefix = [IO.Path]::GetFullPath($runtimeBase).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe runtime target: $resolved"
    }
}

function Find-AppBrowser {
    $candidates = @()
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
        if ($base) {
            $candidates += Join-Path $base 'Google\Chrome\Application\chrome.exe'
            $candidates += Join-Path $base 'Microsoft\Edge\Application\msedge.exe'
        }
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

try {
    Write-Host ''
    Write-Host '  CamDongHang - Camera / QR / Barcode (khong WhatsApp)'
    Write-Host "  Thu muc: $appRoot"
    if (-not [Environment]::Is64BitOperatingSystem -or [Environment]::OSVersion.Version.Major -lt 10) {
        throw 'Goi nay can Windows 10/11 64-bit (Intel/AMD).'
    }
    foreach ($file in @('app.py', 'public\index.html', 'public\script.js', 'public\scanner-worker.js', 'public\vendor\zxing\zxing_reader.wasm')) {
        if (-not (Test-Path -LiteralPath (Join-Path $appRoot $file) -PathType Leaf)) {
            throw "Thieu file $file. Hay giai nen TOAN BO goi ZIP truoc khi chay."
        }
    }

    # Repeated launches must not prepare the runtime simultaneously.
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $rootHash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($appRoot.ToLowerInvariant()))).Replace('-', '').Substring(0, 24) }
    finally { $sha.Dispose() }
    $mutex = New-Object Threading.Mutex($false, "Local\CamDongHangRuntime-$rootHash")
    $locked = $false
    try {
        try { $locked = $mutex.WaitOne(60000) }
        catch [Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { throw 'Dang chuan bi o cua so khac. Hay doi mot chut roi chay lai.' }
        if (Test-AppPython $pythonPath) {
            Write-Host "  [OK] Python $runtimeVersion da san sang; khong can cai lai."
        } else {
            $installerDirectory = Join-Path $appRoot 'installer'
            New-Item -ItemType Directory -Force -Path $installerDirectory, $runtimeBase | Out-Null
            $archivePath = Join-Path $installerDirectory $archiveName
            if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
                Write-Host '  [SETUP] Dang tai Python tu python.org (chi khi thieu goi kem theo)...'
                [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
                $downloadPath = Join-Path $installerDirectory "$archiveName.download-$PID.zip"
                Invoke-WebRequest -UseBasicParsing -Uri $archiveUrl -OutFile $downloadPath -TimeoutSec 120
                if ((Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $archiveHash) {
                    throw 'File Python tai ve khong dung SHA-256. Hay tai lai goi day du.'
                }
                Move-Item -LiteralPath $downloadPath -Destination $archivePath -Force
            }
            if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $archiveHash) {
                throw "Goi Python bi hong: $archivePath. Hay chep lai file nay tu goi ZIP day du."
            }
            Write-Host '  [SETUP] Dang chuan bi Python rieng trong thu muc ung dung...'
            $stage = Join-Path $runtimeBase ('.setup-' + [Guid]::NewGuid().ToString('N'))
            Assert-RuntimeChild $stage
            Expand-Archive -LiteralPath $archivePath -DestinationPath $stage
            if (-not (Test-AppPython (Join-Path $stage 'python.exe'))) {
                throw 'Python kem theo khong chay duoc. Kiem tra Windows 10/11 64-bit va phan mem bao ve may.'
            }
            if (Test-Path -LiteralPath $runtimeDirectory) {
                $broken = Join-Path $runtimeBase ('python-broken-' + [Guid]::NewGuid().ToString('N'))
                Assert-RuntimeChild $runtimeDirectory
                Assert-RuntimeChild $broken
                Move-Item -LiteralPath $runtimeDirectory -Destination $broken
            }
            Assert-RuntimeChild $runtimeDirectory
            Move-Item -LiteralPath $stage -Destination $runtimeDirectory
            Write-Host '  [OK] Chuan bi xong. Cac lan sau se dung lai Python nay.'
        }
    } finally {
        if ($locked) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }

    if ($CheckOnly) {
        Write-Host "  [OK] Kiem tra xong: $pythonPath"
        exit 0
    }
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
    try { $listener.Start() }
    catch { throw "Cong $Port dang duoc dung. Mo http://localhost:$Port hoac dong cua so CamDongHang cu." }
    finally { $listener.Stop() }

    $serverArguments = @('-X', 'utf8', (Join-Path $appRoot 'app.py'), '--port', "$Port", '--no-bot')
    if ($NoBrowser) { $serverArguments += '--no-browser' }
    else {
        $browserPath = Find-AppBrowser
        if ($browserPath) { $serverArguments += @('--browser-path', $browserPath) }
        else { Write-Host '  [INFO] Se mo trinh duyet mac dinh. Dung Chrome/Edge neu camera khong hien.' }
    }
    Write-Host "  [START] http://localhost:$Port - giu cua so nay mo khi quay."
    Set-Location -LiteralPath $appRoot
    & $pythonPath @serverArguments
    exit $LASTEXITCODE
} catch {
    Write-Host ''
    Write-Host ('  [ERROR] ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
