// electron-builder skips editing the .exe when signAndEditExecutable is false (that setting avoids a tool download that needs symlink
// rights on Windows). The icon and the version details are written here instead, with the small rcedit tool, before the installer is made.
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'darwin') {
    // No paid certificate yet: an ad-hoc signature (no identity) at least makes the app a valid, complete bundle. Without any signature macOS on
    // Apple Silicon calls a downloaded app "damaged"; with this one the person gets the usual "unidentified developer" message and can allow it.
    const { execFileSync } = require('child_process');
    const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
    console.log('  • ad-hoc signature written to', path.basename(app));
    return;
  }
  if (context.electronPlatformName !== 'win32') return;
  const { rcedit } = require('rcedit');
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const v = context.packager.appInfo.version;
  await rcedit(exe, {
    icon: path.join(__dirname, 'icon.ico'),
    'version-string': {
      ProductName: 'A-tuls',
      FileDescription: 'A-tuls',
      CompanyName: 'Rizqaputra',
      LegalCopyright: 'Copyright (c) Rizqaputra',
      OriginalFilename: 'A-tuls.exe',
      InternalName: 'A-tuls',
    },
    'file-version': v,
    'product-version': v,
  });
  console.log('  • icon and version details written to', path.basename(exe));
};
