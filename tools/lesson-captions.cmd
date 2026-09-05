@echo off
chcp 949 >nul
REM 수업 자막을 개념어로 바꿔 보고서에 올린다.
REM 작업 스케줄러가 매일 새벽 1시에 이것을 부른다.
REM
REM 서버 크론이 23:00~23:59 에 영상 제목으로 먼저 채운다.
REM 이 도구는 그 뒤에 돌아야 제목으로 채워진 날을 찾는다. 그래서 1시다.
REM 손으로 돌릴 때는 이 파일을 두 번 눌러도 된다.
REM
REM !! 이 파일은 cp949 로 저장해야 한다. UTF-8 이면 cmd 가 한글 주석을 깨뜨려
REM    엉뚱한 명령으로 읽고 곧바로 실패한다 (2026-09-05 에 실제로 겪음).
REM    따옴표 기호나 긴 줄표처럼 cp949 에 없는 글자도 쓰지 말 것.

cd /d "%~dp0.."
if not exist "tools\logs" mkdir "tools\logs"
set LOG=tools\logs\lesson-captions.log

echo.>>"%LOG%"
echo ===== %date% %time% =====>>"%LOG%"
python "tools\lesson-captions.py" --days 14 >>"%LOG%" 2>&1
echo (exit %errorlevel%)>>"%LOG%"

REM 기록이 끝없이 자라지 않게 뒤 2000줄만 남긴다
powershell -NoProfile -Command "$p='%LOG%'; $c=Get-Content $p; if ($c.Count -gt 2000) { $c | Select-Object -Last 2000 | Set-Content $p }" 2>nul
