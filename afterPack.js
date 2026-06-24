const { execSync } = require('child_process')
const path = require('path')

/** Re-sign with ad-hoc identity so macOS shows "unidentified developer"
 *  instead of "damaged" — the latter blocks even right-click → Open. */
exports.default = async function afterPack(context) {
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productName}.app`)
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' })
}
