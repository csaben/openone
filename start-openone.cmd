@echo off
rem Launch openone without leaving a console window open
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
