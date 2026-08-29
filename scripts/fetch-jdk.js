const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const jdkDir = path.resolve(__dirname, '../android/jdk21');
if (fs.existsSync(path.join(jdkDir, 'bin/java.exe'))) {
  console.log('JDK 21 already present at:', jdkDir);
  process.exit(0);
}

console.log('Downloading OpenJDK 21 LTS for Gradle build...');
const psScript = `
$ProgressPreference = 'SilentlyContinue'
$url = 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.6%2B7/OpenJDK21U-jdk_x64_windows_hotspot_21.0.6_7.zip'
$out = 'android/jdk21.zip'
Invoke-WebRequest -Uri $url -OutFile $out
Expand-Archive -Path $out -DestinationPath 'android/jdk21_tmp' -Force
Remove-Item $out -Force
$first = Get-ChildItem 'android/jdk21_tmp' | Select-Object -First 1
Move-Item $first.FullName 'android/jdk21'
Remove-Item 'android/jdk21_tmp' -Recurse -Force
`;

const psPath = path.resolve(__dirname, '../fetch_jdk.ps1');
fs.writeFileSync(psPath, psScript, 'utf8');

try {
  execSync(`powershell -ExecutionPolicy Bypass -File "${psPath}"`, { stdio: 'inherit' });
  console.log('JDK 21 successfully installed in android/jdk21');
} catch (e) {
  console.error('Failed to download JDK 21:', e.message);
} finally {
  if (fs.existsSync(psPath)) fs.unlinkSync(psPath);
}
