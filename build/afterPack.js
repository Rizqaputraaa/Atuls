// electron-builder skips editing the .exe when signAndEditExecutable is false (that setting avoids a tool download that needs symlink
// rights on Windows). The icon and the version details are written here instead, with the small rcedit tool, before the installer is made.
const path = require('path');

exports.default = async function afterPack(context) {
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
