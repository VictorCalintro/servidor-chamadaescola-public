@echo off
setlocal
cd /d "%~dp0"
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo Arquivo .env criado. Preencha as senhas e SESSION_SECRET antes de iniciar.
  exit /b 1
)
if not exist "node_modules" (
  npm install
)
npm start
