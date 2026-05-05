"""
Build script for Monolith.
Packages the app into executables using PyInstaller.

Usage:
    py -3.12 build.py portable     # Single .exe file
    py -3.12 build.py setup        # Installer-ready folder (or build installer if Inno Setup available)
    py -3.12 build.py all          # Both

Output:
    dist/Monolith_Portable/Monolith.exe   (single file)
    dist/Monolith_Setup/Monolith.exe      (folder)
"""
import os
import sys
import subprocess
import shutil
import time


def get_inno_setup_compiler():
    """Find Inno Setup compiler (ISCC.exe)."""
    possible_paths = [
        r"C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
        r"C:\Program Files\Inno Setup 6\ISCC.exe",
    ]
    for path in possible_paths:
        if os.path.exists(path):
            return path
    return None


def build_portable():
    """Build a single-file portable executable."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)

    final_dir = os.path.join(script_dir, 'dist', 'Monolith_Portable')
    # Use a temp directory to avoid locked-file conflicts with old builds
    temp_dir = os.path.join(script_dir, 'dist', f"Monolith_Portable_{int(time.time())}")

    icon_path = os.path.join(script_dir, 'assets', 'icon.ico')
    if not os.path.exists(icon_path):
        print(f"Warning: Icon not found at {icon_path}")
        icon_arg = []
    else:
        icon_arg = ['--icon', icon_path]

    cmd = [
        sys.executable, '-m', 'PyInstaller',
        '--windowed',
        '--onefile',
        '--name', 'Monolith',
        '--clean',
        '--noconfirm',
        '--distpath', temp_dir,
        '--workpath', os.path.join(script_dir, 'build', 'portable'),
        '--add-data', f'frontend{os.pathsep}frontend',
        '--add-data', f'configs{os.pathsep}configs',
        '--collect-all', 'winpty',
        *icon_arg,
        'main.py'
    ]

    print(f"Building portable single-file executable...")
    print(f"Command: {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=script_dir)

    if result.returncode != 0:
        print("Portable build failed!")
        return False

    # Replace old build with new one
    if os.path.exists(final_dir):
        shutil.rmtree(final_dir, ignore_errors=True)
    os.rename(temp_dir, final_dir)

    exe_src = os.path.join(final_dir, 'Monolith.exe')
    print(f"\nPortable build complete!")
    print(f"Output: {exe_src}")
    return True


def build_setup_folder():
    """Build a folder-based distribution (for installer)."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)

    final_dir = os.path.join(script_dir, 'dist', 'Monolith_Setup')
    temp_dir = os.path.join(script_dir, 'dist', f"Monolith_Setup_{int(time.time())}")

    icon_path = os.path.join(script_dir, 'assets', 'icon.ico')
    if not os.path.exists(icon_path):
        print(f"Warning: Icon not found at {icon_path}")
        icon_arg = []
    else:
        icon_arg = ['--icon', icon_path]

    cmd = [
        sys.executable, '-m', 'PyInstaller',
        '--windowed',
        '--onedir',
        '--name', 'Monolith',
        '--clean',
        '--noconfirm',
        '--distpath', temp_dir,
        '--workpath', os.path.join(script_dir, 'build', 'setup'),
        '--add-data', f'frontend{os.pathsep}frontend',
        '--add-data', f'configs{os.pathsep}configs',
        '--collect-all', 'winpty',
        *icon_arg,
        'main.py'
    ]

    print(f"\nBuilding setup folder distribution...")
    print(f"Command: {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=script_dir)

    if result.returncode != 0:
        print("Setup build failed!")
        return False

    # Replace old build with new one
    if os.path.exists(final_dir):
        shutil.rmtree(final_dir, ignore_errors=True)
    os.rename(temp_dir, final_dir)

    exe_path = os.path.join(final_dir, 'Monolith', 'Monolith.exe')
    print(f"\nSetup folder build complete!")
    print(f"Output folder: {os.path.join(final_dir, 'Monolith')}")
    print(f"Executable: {exe_path}")
    return True


def build_inno_installer():
    """Build a Windows installer using Inno Setup if available."""
    iscc = get_inno_setup_compiler()
    if not iscc:
        print("\nInno Setup not found. Skipping installer creation.")
        print("Download Inno Setup from: https://jrsoftware.org/isdl.php")
        print("Or zip the Monolith_Setup folder manually.")
        return False

    script_dir = os.path.dirname(os.path.abspath(__file__))
    iss_path = os.path.join(script_dir, 'installer.iss')

    if not os.path.exists(iss_path):
        print(f"\nInstaller script not found: {iss_path}")
        print("Creating a basic installer script...")
        create_inno_script(script_dir)

    print(f"\nBuilding installer with Inno Setup...")
    result = subprocess.run([iscc, iss_path], cwd=script_dir)

    if result.returncode != 0:
        print("Installer build failed!")
        return False

    installer_path = os.path.join(script_dir, 'dist', 'Monolith_Setup.exe')
    print(f"\nInstaller build complete!")
    print(f"Output: {installer_path}")
    return True


def create_inno_script(script_dir):
    """Create a basic Inno Setup script."""
    app_version = "0.1.0"
    iss_content = f"""; Inno Setup Script for Monolith
[Setup]
AppName=Monolith
AppVersion={app_version}
DefaultDirName={{autopf}}\\Monolith
DefaultGroupName=Monolith
OutputDir=dist
OutputBaseFilename=Monolith_Setup
SetupIconFile=assets\\icon.ico
UninstallDisplayIcon={{app}}\\Monolith.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Files]
Source: "dist\\Monolith_Setup\\Monolith\\*"; DestDir: "{{app}}"; Flags: ignoreversion recursesubdirs

[Icons]
Name: "{{group}}\\Monolith"; Filename: "{{app}}\\Monolith.exe"
Name: "{{autodesktop}}\\Monolith"; Filename: "{{app}}\\Monolith.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop icon"; GroupDescription: "Additional icons:"

[Run]
Filename: "{{app}}\\Monolith.exe"; Description: "Launch Monolith"; Flags: nowait postinstall skipifsilent
"""
    iss_path = os.path.join(script_dir, 'installer.iss')
    with open(iss_path, 'w', encoding='utf-8') as f:
        f.write(iss_content)
    print(f"Created: {iss_path}")


def main():
    if len(sys.argv) < 2:
        print("Usage: py -3.12 build.py [portable|setup|all]")
        print("")
        print("  portable  - Single .exe file (no installer)")
        print("  setup     - Folder distribution + optional Inno Setup installer")
        print("  all       - Both portable and setup")
        sys.exit(1)

    mode = sys.argv[1].lower()

    if mode == 'portable':
        build_portable()
    elif mode == 'setup':
        build_setup_folder()
        build_inno_installer()
    elif mode == 'all':
        build_portable()
        build_setup_folder()
        build_inno_installer()
    else:
        print(f"Unknown mode: {mode}")
        print("Use: portable, setup, or all")
        sys.exit(1)


if __name__ == '__main__':
    main()
