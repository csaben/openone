# openone tasks. `just install` is the one to remember.
set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"]

installed := env_var_or_default('LOCALAPPDATA', '') + '\Programs\openone'
appdata := env_var_or_default('APPDATA', '') + '\openone'
mac_app := '/Applications/openone.app'
mac_data := env_var_or_default('HOME', '') + '/Library/Application Support/openone'

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
[windows]
build:
    npm install --no-audit --no-fund
    npm test
    npm run dist

# build dist/mac-arm64/openone.app and a .dmg
[macos]
build:
    npm install --no-audit --no-fund
    npm test
    npm run dist:mac

# build, then install for this user, start at login, and launch
[windows]
install: build stop
    $v = (Get-Content package.json | ConvertFrom-Json).version; Start-Process -Wait "dist\openone-setup-$v.exe" -ArgumentList '/S'
    just _seed-config
    Start-Process "{{installed}}\openone.exe"
    Write-Host "openone installed to {{installed}}; it starts at login (toggle in the tray)."

# build, then install to /Applications, start at login, and launch
[macos]
install: build stop
    rm -rf "{{mac_app}}"
    cp -R dist/mac-arm64/openone.app "{{mac_app}}"
    just _seed-config
    open "{{mac_app}}"
    @echo "openone installed to {{mac_app}}; it starts at login (toggle in the menu bar)."

# close any running openone (installed or dev)
[windows]
stop:
    Get-Process openone -ErrorAction SilentlyContinue | Stop-Process -Force; exit 0
    Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -match [regex]::Escape((Get-Location).Path) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; exit 0

# close any running openone (installed or dev)
[macos]
stop:
    -pkill -x openone
    -pkill -f "{{justfile_directory()}}/node_modules/electron/dist/Electron.app"

# copy ./config.json over the installed config, then restart it
[windows]
push-config: stop
    New-Item -ItemType Directory -Force "{{appdata}}" | Out-Null; Copy-Item config.json "{{appdata}}\config.json" -Force
    Start-Process "{{installed}}\openone.exe"

# copy ./config.json over the installed config, then restart it
[macos]
push-config: stop
    mkdir -p "{{mac_data}}" && cp config.json "{{mac_data}}/config.json"
    open "{{mac_app}}"

# remove the installed app (config in %APPDATA%\openone is kept)
[windows]
uninstall: stop
    Start-Process -Wait "{{installed}}\Uninstall openone.exe" -ArgumentList '/S'

# remove the installed app (config in ~/Library/Application Support/openone is kept)
[macos]
uninstall: stop
    rm -rf "{{mac_app}}"

# first install only: reuse this checkout's config.json instead of auto-detecting
[windows]
_seed-config:
    if ((Test-Path config.json) -and -not (Test-Path "{{appdata}}\config.json")) { New-Item -ItemType Directory -Force "{{appdata}}" | Out-Null; Copy-Item config.json "{{appdata}}\config.json"; Write-Host 'copied ./config.json to {{appdata}}' }

# first install only: reuse this checkout's config.json instead of auto-detecting
[macos]
_seed-config:
    if [ -f config.json ] && [ ! -f "{{mac_data}}/config.json" ]; then mkdir -p "{{mac_data}}" && cp config.json "{{mac_data}}/config.json" && echo "copied ./config.json to {{mac_data}}"; fi
