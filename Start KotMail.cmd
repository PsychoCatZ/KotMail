@echo off
node "%~dp0scripts\start-kotmail.mjs" %*
if errorlevel 1 pause
