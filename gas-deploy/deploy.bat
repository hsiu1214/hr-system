@echo off
REM 推上 Google Apps Script
REM
REM 前置：
REM   1) 已執行 npx @google/clasp login   （token 只存本機 %USERPROFILE%\.clasprc.json）
REM   2) 已把 .clasp.json.tmpl 改名為 .clasp.json 並填入你的 scriptId
REM
REM 用法：
REM   deploy.bat                 只 push（更新雲端 HEAD，不碰既有部署）
REM   deploy.bat <deploymentId>  push + redeploy（更新既有部署，**原 /exec 網址不變**）
REM
REM 注意：clasp v3 的 deploy 會建「新」部署（新 /exec 網址）；更新既有部署請用 redeploy。
setlocal
cd /d "%~dp0"

call npx @google/clasp push --force

if "%~1"=="" (
  echo 未指定 deploymentId：只 push，未更新任何部署
  echo 要更新既有部署請執行：deploy.bat 你的deploymentId
) else (
  call npx @google/clasp redeploy %~1
)
endlocal
