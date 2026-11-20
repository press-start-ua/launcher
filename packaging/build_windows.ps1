# Builds the portable Windows version into dist/ and checks that the exe really starts.
# Called by .github/workflows/windows.yml (kept here so the build can change without editing the
# workflow file). Writes VERSION to $env:GITHUB_ENV when it runs in GitHub Actions.
$ErrorActionPreference = 'Stop'
$version = (Select-String -Path app.py -Pattern "^VERSION = '(.+)'").Matches[0].Groups[1].Value
if ($env:GITHUB_ENV) { "VERSION=$version" | Out-File -FilePath $env:GITHUB_ENV -Append }
python -m pip list | Select-String -Pattern 'PySide6|shiboken|pyinstaller'

$name = 'Press Start UA Launcher'
$common = @('--noconfirm', '--clean', '--onedir',
            '--icon', 'assets/icon.ico',
            '--add-data', 'assets/icon.png;assets',
            '--add-data', 'catalog;catalog',
            '--add-data', 'wit/windows;wit/windows',
            '--add-data', 'wit/gpl-2.0.txt;wit',
            '--add-data', 'wit/README.txt;wit',
            '--exclude-module', 'tkinter')

function Test-Start($dir, $exe) {
    Remove-Item "$dir/data" -Recurse -Force -ErrorAction SilentlyContinue
    $p = Start-Process -FilePath "$dir/$exe" -ArgumentList '--selftest' -PassThru `
        -RedirectStandardOutput "$dir/../stdout.txt" -RedirectStandardError "$dir/../stderr.txt"
    if (!$p.WaitForExit(90000)) { $p.Kill(); Write-Host 'the exe hung' }
    Write-Host ("exit code: {0} (0x{1:X8})" -f $p.ExitCode, $p.ExitCode)
    Get-Content "$dir/../stdout.txt", "$dir/../stderr.txt" -ErrorAction SilentlyContinue | Select-Object -Last 60
    $log = "$dir/data/crash.log"
    if (Test-Path $log) { Get-Content $log } else { Write-Host 'no crash.log' }
    return (Test-Path $log) -and (Select-String -Path $log -Pattern 'selftest ok' -Quiet)
}

pyinstaller @common --windowed --name $name app.py
$dir = "dist/$name"
& "$dir/_internal/wit/windows/wit.exe" --version
if (!(Test-Start $dir "$name.exe")) {
    Write-Host '--- the windowed exe did not start; building a console copy to see why ---'
    pyinstaller @common --console --debug=imports --name debug app.py --distpath dist_debug
    Test-Start 'dist_debug/debug' 'debug.exe' | Out-Null
    throw 'the exe did not start'
}

Remove-Item "$dir/data" -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$dir/data" | Out-Null
New-Item -ItemType File -Force -Path "$dir/data/.keep" | Out-Null
Copy-Item packaging/README_Windows.txt "$dir/README.txt"
Copy-Item LICENSE "$dir/LICENSE.txt"
Compress-Archive -Path $dir -DestinationPath "PressStartUA_Launcher_Windows_$version.zip" -Force
