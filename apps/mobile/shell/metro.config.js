// Metro loads this file as CommonJS; static imports are not supported here.
/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('path');
const fs = require('fs');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
/* eslint-enable @typescript-eslint/no-require-imports */

// The tested TypeScript core lives one level up (apps/mobile/src) and is
// imported in place, not copied. It uses NodeNext-style "./x.js" specifiers
// that point at .ts files, which Metro cannot resolve on its own.
const coreDir = path.resolve(__dirname, '../src');

const config = {
  watchFolders: [coreDir],
  resolver: {
    // Core files sit outside this project; let them resolve the shell's modules.
    nodeModulesPaths: [path.resolve(__dirname, 'node_modules')],
    extraNodeModules: { '@greenguard/mobile-core': coreDir },
    resolveRequest: (context, moduleName, platform) => {
      if (
        moduleName.startsWith('.') &&
        moduleName.endsWith('.js') &&
        context.originModulePath.startsWith(coreDir)
      ) {
        const base = path.resolve(
          path.dirname(context.originModulePath),
          moduleName.slice(0, -3),
        );
        if (fs.existsSync(base + '.ts')) {
          return { type: 'sourceFile', filePath: base + '.ts' };
        }
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
