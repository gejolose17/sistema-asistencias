@echo off
title Sistema de Listas de Asistencia y Participacion
cd /d "%~dp0"
echo Iniciando Sistema de Listas de Asistencia en puerto 3050...
start "" "http://localhost:3050"
node server.js
pause
