# openone tasks. `just install` is the one to remember.
set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"]

installed := env_var('LOCALAPPDATA') + '\Programs\openone'
appdata := env_var('APPDATA') + '\openone'

# list recipes
default:
    @just --list

# run from source (uses ./config.json)
dev:
    npm start

test:
    npm test

# re-render tray/toast/app PNGs from assets/*.svg
icons:
    npm run icons

# build dist\openone-setup-<version>.exe
build:
    npm install --no-audit --no-fund
    npm test
    npm run dist

# build, then install for this user, start at login, and launch
install: build stop
    $v = (Get-Content package.json | ConvertFrom-Json).version; Start-Process -Wait "dist\openone-setup-$v.exe" -ArgumentList '/S'
    just _seed-config
    Start-Process "{{installed}}\openone.exe"
    Write-Host "openone installed to {{installed}}; it starts at login (toggle in the tray)."

# close any running openone (installed or dev)
stop:
    Get-Process openone -ErrorAction SilentlyContinue | Stop-Process -Force; exit 0
    Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -match [regex]::Escape((Get-Location).Path) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; exit 0

# copy ./config.json over the installed config, then restart it
push-config: stop
    New-Item -ItemType Directory -Force "{{appdata}}" | Out-Null; Copy-Item config.json "{{appdata}}\config.json" -Force
    Start-Process "{{installed}}\openone.exe"

# remove the installed app (config in %APPDATA%\openone is kept)
uninstall: stop
    Start-Process -Wait "{{installed}}\Uninstall openone.exe" -ArgumentList '/S'

# first install only: reuse this checkout's config.json instead of auto-detecting
_seed-config:
    if ((Test-Path config.json) -and -not (Test-Path "{{appdata}}\config.json")) { New-Item -ItemType Directory -Force "{{appdata}}" | Out-Null; Copy-Item config.json "{{appdata}}\config.json"; Write-Host 'copied ./config.json to {{appdata}}' }
