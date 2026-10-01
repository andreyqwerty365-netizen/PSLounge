# Windows packaging

Build on 64-bit Windows with Python 3.10+ and Inno Setup 6.4.3. Python dependencies are pinned in `requirements-build.txt`; the generated installer is unsigned until a release signing process is configured.

```bat
build_exe.bat
powershell -ExecutionPolicy Bypass -File installer\build-installer.ps1 -SourceDir "client_release\<version>-<build timestamp>\PS Lounge" -Version "2.1.0"
```

Use the actual version assigned to the build. `Version` must contain three numeric components. The sample version is not a claim that the modernization is included in the tagged stable 2.1 release.

Every package and installer is written to a new timestamped directory. Previous output is retained. PyInstaller discovers normal `pslounge` imports, including the business package; templates and static files are bundled explicitly. No licences, private signing keys or runtime database are added.

The installer places application files under `%LOCALAPPDATA%\Programs\PS Lounge`, creates Start Menu shortcuts and optionally a desktop shortcut, and requires no administrative privileges. Data lives in the separate `%LOCALAPPDATA%\PS Lounge` directory, survives upgrades and uninstall, and is never included in an `UninstallDelete` rule.

The installer and generated EXE must be tested on Windows before distribution: fresh install, existing portable-data migration, in-place upgrade, shortcuts, licence compatibility on the same PC, cash/stock/pass operations, export, restore, and uninstall with preserved data. These Windows binaries were not built or tested in the Linux cloud environment.
