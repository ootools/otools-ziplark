/**
 * 六平台 / 架构分包矩阵。
 * ------------------------------------------------------------------
 * 与 otools-fileshare / otools-releasehub / otools-zitext 的分包约定保持一致：
 * Release 里放 <packid>-<version>-<suffix>.oplg，市场侧用对应的
 * packageUrl* 字段，并置 packageMode=1（客户端按平台优先下载，失败回退）。
 *
 * Ziplark 是原生插件（`native` cdylib），六个包各自内嵌对应平台的动态库，
 * 所以这里的矩阵既是市场上报字段的来源，也是「哪个平台该出哪个包」的准绳。
 */
export const PLATFORM_TARGETS = [
    { id: 'macos-arm64', platform: 'macos', arch: 'arm64', suffix: 'macos', field: 'packageUrlMacos' },
    { id: 'macos-x64', platform: 'macos', arch: 'x64', suffix: 'macos-intel', field: 'packageUrlMacosIntel' },
    { id: 'windows-x64', platform: 'windows', arch: 'x64', suffix: 'windows', field: 'packageUrlWindows' },
    { id: 'windows-arm64', platform: 'windows', arch: 'arm64', suffix: 'windows-arm', field: 'packageUrlWindowsArm' },
    { id: 'linux-x64', platform: 'linux', arch: 'x64', suffix: 'linux', field: 'packageUrlLinux' },
    { id: 'linux-arm64', platform: 'linux', arch: 'arm64', suffix: 'linux-arm', field: 'packageUrlLinuxArm' },
];

export function platformPackageName(packid, version, suffix) {
    return `${packid}-${version}-${suffix}.oplg`;
}

export function combinedPackageName(packid, version) {
    return `${packid}-${version}.oplg`;
}

/** 给定发布模式，返回本次应该出现的全部 .oplg 文件名。 */
export function expectedPackageNames(packid, version, platformPackages) {
    return platformPackages
        ? PLATFORM_TARGETS.map((target) => platformPackageName(packid, version, target.suffix))
        : [combinedPackageName(packid, version)];
}
