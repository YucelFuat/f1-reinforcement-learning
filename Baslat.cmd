@echo off
rem RL Yarış Laboratuvarı – çift tıklayarak başlat (Windows).
rem Sunucuyu bu klasörde başlatır ve uygulamayı kendi penceresinde açar (Edge/Chrome uygulama modu).
chcp 65001 >nul
setlocal
title RL Yarış Laboratuvarı
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

echo.
echo   RL Yarış Laboratuvarı başlatılıyor...
echo   Uygulama penceresi birazdan açılacak.
echo   Bu siyah pencereyi kapatmak uygulamayı durdurur.
echo.
node server.js --app
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo   Sunucu bir hatayla kapandı. Yukarıdaki mesajı kontrol et.
echo.
pause
exit /b 1

:nonode
echo.
echo   HATA: Node.js bulunamadı.
echo.
echo   Bu uygulama Node.js ile çalışır. Node.js kuruluysa ama bu mesajı görüyorsan
echo   bilgisayarı yeniden başlatmayı dene: PATH ayarı henüz güncellenmemiş olabilir.
echo   Kurulu değilse https://nodejs.org adresinden LTS sürümünü kurup bu dosyaya
echo   yeniden çift tıkla.
echo.
pause
exit /b 1
