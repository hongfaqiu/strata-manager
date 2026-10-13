import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const nativeRoot = path.join(root, 'apps/desktop/src-tauri');
const config = JSON.parse(readFileSync(path.join(nativeRoot, 'tauri.conf.json'), 'utf8'));
const nsis = config.bundle.windows.nsis;
const languages = ['English', 'SimpChinese', 'TradChinese', 'Japanese', 'Korean', 'German', 'French', 'Spanish', 'Portuguese', 'Russian'];

test('NSIS bundles all application languages with English as the unsupported-system fallback', () => {
  assert.deepEqual(nsis.languages, languages);
  assert.equal(nsis.displayLanguageSelector, true);
  assert.equal(config.plugins.updater.windows.installMode, 'passive');
  assert.ok(existsSync(path.resolve(nativeRoot, nsis.installerHooks)));
});

const compiler = process.env.TAURI_NSIS_COMPILER ?? path.join(process.env.LOCALAPPDATA ?? '', 'tauri/NSIS/makensis.exe');
const nativeAvailable = process.platform === 'win32' && existsSync(compiler);
const nsisString = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"');

test('real NSIS installer and uninstaller skip the language dialog for passive, update and silent modes', { skip: !nativeAvailable }, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'strata-installer-language-'));
  const fixture = path.join(directory, 'language-smoke.nsi');
  const executable = path.join(directory, 'language-smoke.exe');
  const marker = path.join(directory, 'mode.txt');
  try {
    writeFileSync(fixture, `Unicode true
RequestExecutionLevel user
Name "Strata language smoke"
OutFile "${nsisString(executable)}"
!include MUI2.nsh
!include FileFunc.nsh
!include "${nsisString(path.resolve(nativeRoot, nsis.installerHooks))}"
!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "Software\\StrataLanguageSmoke\\${nsisString(path.basename(directory))}"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_INSTFILES
${languages.map(language => `!insertmacro MUI_LANGUAGE "${language}"`).join('\n')}
!insertmacro MUI_RESERVEFILE_LANGDLL
Function .onInit
  StrCpy $R0 "preserved"
  !insertmacro MUI_LANGDLL_DISPLAY
  FileOpen $R1 "$EXEDIR\\mode.txt" w
  FileWrite $R1 "$R0:$LANGUAGE"
  FileClose $R1
  WriteUninstaller "$EXEDIR\\language-uninstaller-smoke.exe"
  SetErrorLevel 0
  Quit
FunctionEnd
Function un.onInit
  StrCpy $R0 "preserved"
  !insertmacro MUI_UNGETLANGUAGE
  FileOpen $R1 "$EXEDIR\\mode.txt" w
  FileWrite $R1 "$R0:$LANGUAGE"
  FileClose $R1
  SetErrorLevel 0
  Quit
FunctionEnd
Section
SectionEnd
Section "Uninstall"
SectionEnd
`);
    execFileSync(compiler, ['/V2', fixture], { timeout: 30_000, windowsHide: true, stdio: 'pipe' });
    for (const mode of ['/P', '/UPDATE', '/S']) {
      writeFileSync(marker, 'not run');
      const installerResult = spawnSync(executable, [mode], { timeout: 10_000, windowsHide: true, encoding: 'utf8' });
      assert.match(readFileSync(marker, 'utf8'), /^preserved:\d+$/, `installer ${mode}; status ${installerResult.status}; error ${installerResult.error?.message}`);
      assert.equal(installerResult.status, 0, `installer ${mode}; marker ${readFileSync(marker, 'utf8')}`);
      assert.match(readFileSync(marker, 'utf8'), /^preserved:\d+$/, `installer ${mode}`);
      writeFileSync(marker, 'not run');
      execFileSync(path.join(directory, 'language-uninstaller-smoke.exe'), [mode, `_?=${directory}`], { timeout: 10_000, windowsHide: true, stdio: 'pipe' });
      assert.match(readFileSync(marker, 'utf8'), /^preserved:\d+$/, `uninstaller ${mode}`);
    }
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('strata-installer-language-'));
    rmSync(directory, { recursive: true, force: true });
  }
});
