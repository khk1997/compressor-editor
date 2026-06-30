const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const { Arch } = require('electron-builder')

/**
 * After packing the .app:
 *  1. Bundle the arch-matching img2webp (+ its dylibs) into Contents/Resources,
 *     so transparent animated WebP works on machines without a Homebrew libwebp.
 *  2. Re-sign with an ad-hoc identity so macOS shows "unidentified developer"
 *     instead of "damaged" — the latter blocks even right-click → Open.
 */
exports.default = async function afterPack(context) {
  const productName = context.packager.appInfo.productName
  const appPath = path.join(context.appOutDir, `${productName}.app`)

  if (context.electronPlatformName === 'darwin') {
    const archName = Arch[context.arch]
    const src = path.join(__dirname, 'resources', 'img2webp', archName)
    const dest = path.join(appPath, 'Contents', 'Resources', 'img2webp')
    if (fs.existsSync(path.join(src, 'img2webp'))) {
      fs.cpSync(src, dest, { recursive: true })
      // Sign the binary + dylibs before sealing the app, so the app signature
      // covers them.
      for (const f of fs.readdirSync(dest)) {
        execSync(`codesign --force --sign - "${path.join(dest, f)}"`, { stdio: 'inherit' })
      }
      console.log(`afterPack: bundled img2webp (${archName})`)
    } else {
      console.warn(
        `afterPack: no bundled img2webp for arch "${archName}" — that build falls back to a system img2webp`
      )
    }
  }

  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' })
}
