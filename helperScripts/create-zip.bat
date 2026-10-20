@echo off
setlocal
pushd "%~dp0.."

set "SEVENZIP="
for %%C in (7z.exe 7zz.exe 7za.exe) do (
    for /f "delims=" %%P in ('where %%C 2^>nul') do (
        if not defined SEVENZIP set "SEVENZIP=%%P"
    )
)
if not defined SEVENZIP if exist "%ProgramFiles%\7-Zip\7z.exe" set "SEVENZIP=%ProgramFiles%\7-Zip\7z.exe"
if not defined SEVENZIP if exist "%ProgramFiles(x86)%\7-Zip\7z.exe" set "SEVENZIP=%ProgramFiles(x86)%\7-Zip\7z.exe"

if not defined SEVENZIP (
    echo 7-Zip was not found. Install 7-Zip or add 7z.exe to PATH, then run this script again.
    popd
    pause
    exit /b 1
)

set "ARCHIVE=%CD%\salesforce-assist-buddy-sc.zip"
set "TEMP_ARCHIVE=%CD%\salesforce-assist-buddy-sc-%RANDOM%-%RANDOM%.tmp.zip"
echo Creating "%ARCHIVE%". 7-Zip will prompt for the ZIP password.
"%SEVENZIP%" a -tzip -mem=AES256 -p "%TEMP_ARCHIVE%" . -xr!.git -xr!node_modules -xr!out -xr!*.zip
set "RESULT=%ERRORLEVEL%"

if not "%RESULT%"=="0" (
    if exist "%TEMP_ARCHIVE%" del /q "%TEMP_ARCHIVE%"
    echo Archive creation failed with 7-Zip exit code %RESULT%.
    popd
    pause
    exit /b %RESULT%
)

move /y "%TEMP_ARCHIVE%" "%ARCHIVE%" >nul
if errorlevel 1 (
    echo Could not move the new archive to "%ARCHIVE%".
    popd
    pause
    exit /b 1
)

echo Created "%ARCHIVE%".
popd
pause
exit /b 0