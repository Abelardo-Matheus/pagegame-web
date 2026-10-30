@echo off
rem =====================================================================
rem  PageGame - instalador da extensao (Windows 10/11, sem instalar nada)
rem  Uso no CMD:
rem    curl -fsSLo "%TEMP%\pagegame.cmd" https://raw.githubusercontent.com/Abelardo-Matheus/pagegame-web/main/instalar.cmd && "%TEMP%\pagegame.cmd"
rem  Opcional: escolha o navegador no fim:  ... "%TEMP%\pagegame.cmd" brave
rem  (chrome, brave ou edge). Sem nada, usa o primeiro que achar.
rem
rem  O que faz:
rem   1. baixa a versao mais nova do GitHub (zip)
rem   2. extrai em %LOCALAPPDATA%\PageGame (sempre a mesma pasta)
rem   3. copia esse caminho e abre a pagina de extensoes do navegador
rem  Rodar de novo = atualizar.
rem =====================================================================
setlocal
title Instalador do PageGame
set "ZIPURL=https://github.com/Abelardo-Matheus/pagegame-web/archive/refs/heads/main.zip"
set "DEST=%LOCALAPPDATA%\PageGame"
set "ZIP=%TEMP%\pagegame-%RANDOM%.zip"
set "NAV=%~1"
set "UPD="

echo.
echo   PageGame - instalador da extensao
echo   =================================
echo.

where curl >nul 2>nul || goto :semferramenta
where tar >nul 2>nul || goto :semferramenta

echo   [1/3] Baixando a versao mais nova...
curl -fsSL -o "%ZIP%" "%ZIPURL%"
if errorlevel 1 (set "MSG=Nao consegui baixar. Confira a internet e tente de novo." & goto :erro)

if exist "%DEST%\manifest.json" set "UPD=1"
echo   [2/3] Extraindo em %DEST%
if exist "%DEST%" rmdir /s /q "%DEST%"
mkdir "%DEST%"
if errorlevel 1 (set "MSG=Nao consegui criar a pasta %DEST%" & goto :erro)
tar -xf "%ZIP%" -C "%DEST%" --strip-components=1
if errorlevel 1 (set "MSG=Nao consegui extrair o arquivo baixado." & goto :erro)
del /q "%ZIP%" >nul 2>nul
if not exist "%DEST%\manifest.json" (set "MSG=O download veio incompleto, sem o manifest.json." & goto :erro)

rem caminho na area de transferencia (para colar na janela de escolher pasta)
<nul set /p "=%DEST%" | clip

rem navegador: o escolhido ou o primeiro instalado
if not defined NAV call :tem chrome.exe && set "NAV=chrome"
if not defined NAV call :tem brave.exe && set "NAV=brave"
if not defined NAV call :tem msedge.exe && set "NAV=edge"
set "EXE=" & set "URL="
if /i "%NAV%"=="chrome" set "EXE=chrome" & set "URL=chrome://extensions"
if /i "%NAV%"=="brave" set "EXE=brave" & set "URL=brave://extensions"
if /i "%NAV%"=="edge" set "EXE=msedge" & set "URL=edge://extensions"

echo.
if defined UPD goto :atualizado

echo   [3/3] Pronto! Agora so falta ativar no navegador (so desta vez):
echo.
echo     a) Ligue o "Modo do desenvolvedor"
echo        (Chrome/Brave: canto de cima, a direita. Edge: menu da esquerda)
echo     b) Clique em "Carregar sem compactacao" (Edge: "Carregar descompactada")
echo     c) Na janela de escolher pasta, clique na barra de endereco,
echo        aperte Ctrl+V e Enter, depois "Selecionar pasta"
echo.
echo     O caminho ja esta copiado: %DEST%
echo.
echo     Depois fixe o PageGame no icone de quebra-cabeca da barra e
echo     clique nele em qualquer pagina para jogar.
goto :abrir

:atualizado
echo   [3/3] Atualizado! Na pagina de extensoes, clique no botao de
echo         recarregar (seta circular) no cartao do PageGame.
echo         Depois recarregue (F5) as abas onde for jogar.

:abrir
echo.
if defined EXE (
  start "" %EXE% "%URL%"
) else (
  echo   Abra a pagina de extensoes do seu navegador ^(ex.: chrome://extensions^).
)
echo.
pause
exit /b 0

:tem
reg query "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\%~1" >nul 2>nul && exit /b 0
reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\%~1" >nul 2>nul && exit /b 0
exit /b 1

:semferramenta
set "MSG=Este Windows nao tem curl/tar. Precisa do Windows 10 (versao 1803) ou mais novo."

:erro
del /q "%ZIP%" >nul 2>nul
echo.
echo   [erro] %MSG%
echo.
pause
exit /b 1
